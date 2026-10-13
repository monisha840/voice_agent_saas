/**
 * Bounded outbound audio queue for one call.
 *
 * Telephony sockets are slow consumers: pushing a whole multi-second reply into `socket.send` at once grows the
 * socket's own buffer without limit, and an interrupted reply cannot be pulled back out of it. This queue holds the
 * frames in OUR memory instead, hands them to the socket only while its buffer is below a high-water mark, caps the
 * total queued, and can be cleared instantly (barge-in, cancellation, call end).
 *
 * It is transport-neutral: items are already-serialized frames; `send` and `bufferedAmount` are injected.
 */
export interface OutboundItem {
  /** The serialized frame to put on the wire. */
  payload: string;
  /** Counted against the queue cap (audio bytes; control frames such as marks weigh 0). */
  weight: number;
  /** True for frames that carry audio: the first one sent after the queue was empty is "first audio byte". */
  audio: boolean;
}

export interface OutboundAudioOptions {
  send: (payload: string) => void;
  /** Bytes the transport still holds unsent (ws: socket.bufferedAmount). */
  bufferedAmount: () => number;
  /** Total weight allowed in the queue; an enqueue beyond it is refused. */
  maxQueuedBytes: number;
  /** Stop handing frames to the transport while it holds more than this. */
  highWaterBytes: number;
  /** How long to wait before re-checking a congested transport. */
  retryMs?: number;
  /** Called when the first audio frame of a burst is actually handed to the transport. */
  onFirstAudioSent?: () => void;
}

export class OutboundAudioSender {
  private queue: OutboundItem[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private gen = 0;
  private awaitingFirstAudio = false;
  /** Frames dropped by clear() over the life of the call. */
  clearedFrames = 0;

  constructor(private readonly opts: OutboundAudioOptions) {}

  /**
   * The current output generation. A turn captures it when it starts and passes it to enqueue()/clear(); clear() starts
   * a new generation, so anything a cancelled turn tries to queue afterwards (a late provider callback) is refused and
   * can never reach the caller or disturb the next turn's audio.
   */
  get generation(): number {
    return this.gen;
  }

  isCurrent(generation: number): boolean {
    return generation === this.gen;
  }

  get queuedWeight(): number {
    return this.queuedBytes;
  }

  get length(): number {
    return this.queue.length;
  }

  /**
   * Queues a batch (e.g. one reply's audio plus its mark). All-or-nothing: if it would exceed the cap NOTHING is
   * queued and false is returned, so a reply is never half-sent.
   */
  enqueue(items: OutboundItem[], generation?: number): boolean {
    if (this.closed || items.length === 0) return false;
    if (generation !== undefined && generation !== this.gen) return false; // a cancelled turn's audio
    const weight = items.reduce((n, i) => n + i.weight, 0);
    if (this.queuedBytes + weight > this.opts.maxQueuedBytes) return false;
    this.awaitingFirstAudio = true;
    this.queue.push(...items);
    this.queuedBytes += weight;
    this.pump();
    return true;
  }

  /**
   * Drops everything not yet handed to the transport and starts a new generation. With `generation` it only acts if that
   * generation is still current (a stale caller must not wipe a newer turn's audio). Returns the dropped weight.
   */
  clear(generation?: number): number {
    if (generation !== undefined && generation !== this.gen) return 0;
    this.gen++;
    const dropped = this.queuedBytes;
    this.clearedFrames += this.queue.length;
    this.queue = [];
    this.queuedBytes = 0;
    this.awaitingFirstAudio = false;
    this.stopTimer();
    this.resolveIdle();
    return dropped;
  }

  /** Resolves once the queue is empty (everything handed to the transport), or right after clear()/close(). */
  idle(): Promise<void> {
    if (this.queue.length === 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.clear();
  }

  private pump(): void {
    this.stopTimer();
    while (this.queue.length > 0 && !this.closed) {
      if (this.opts.bufferedAmount() > this.opts.highWaterBytes) {
        this.timer = setTimeout(() => this.pump(), this.opts.retryMs ?? 10);
        this.timer.unref?.();
        return;
      }
      const item = this.queue.shift()!;
      this.queuedBytes -= item.weight;
      try {
        this.opts.send(item.payload);
      } catch {
        this.clear(); // the transport is gone; nothing more can be delivered
        return;
      }
      if (item.audio && this.awaitingFirstAudio) {
        this.awaitingFirstAudio = false;
        this.opts.onFirstAudioSent?.();
      }
    }
    if (this.queue.length === 0) this.resolveIdle();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
