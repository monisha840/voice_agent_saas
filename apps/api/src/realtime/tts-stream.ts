/**
 * StreamingSpeaker — speaks ONE reply sentence by sentence while the LLM is still producing it.
 *
 *   LLM sentence -> push() -> TTS session -> PCM -> 3,200-byte Exotel chunks -> bounded outbound queue -> caller
 *
 * Provider-neutral (it only knows ITextToSpeech) and transport-neutral (the handler injects how a chunk / a mark
 * becomes a wire frame and how playback is awaited). One speaker per turn.
 *
 * Guarantees:
 *  - Order. Sentences are submitted in push() order on ONE provider session (or, in fallback, one at a time), and audio
 *    is enqueued in arrival order, so sentence N never plays after sentence N+1.
 *  - Bounded memory. Audio the outbound queue refuses is held here up to `maxHeldBytes`; beyond that the reply fails
 *    instead of growing. Pending sentences are bounded by the LLM's own reply length.
 *  - Cancellation. Aborting the turn's signal cancels the provider session, drops held audio and clears what this reply
 *    already put into the outbound queue. Nothing from a cancelled speaker is enqueued afterwards.
 *  - No duplicate audio. A failed stream is only repeated (re-opened with the default voice, or answered with batch
 *    synthesis) while NO audio has been received from it, so nothing the caller heard can be heard twice. After the first
 *    audio a failure ends the reply with what was already delivered.
 *  - No sentence text, audio or credentials in logs or metrics.
 */
import type { ITextToSpeech, TtsStreamingSession } from "../adapters/ai/tts.interface.js";
import { synthesizeWithVoice } from "../adapters/ai/tts-voice.js";
import { chunkPcmForExotel, EXOTEL_MIN_CHUNK_BYTES, pcmDurationMs, ttsAudioToPcm } from "../audio/pcm.js";
import { ProviderRequestError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import type { OutboundAudioSender, OutboundItem } from "./outbound-audio.js";
import type { TurnContext } from "./turn-controller.js";

/** Extra time beyond the audio's duration to wait for the playback mark before giving up. */
const PLAYBACK_GRACE_MS = 1500;
const DRAIN_RETRY_MS = 20;

export interface StreamingSpeakerDeps {
  tts: ITextToSpeech;
  turn: TurnContext;
  sender: OutboundAudioSender;
  sampleRate: number;
  languageCode?: string;
  /** The agent's configured voice; undefined = provider default. */
  voice?: string;
  callId?: string;
  /** The outbound queue's generation when this turn started (OutboundAudioSender.generation): audio of a stale turn is refused. */
  generation: number;
  /** Upper bound on audio held back because the outbound queue was full. */
  maxHeldBytes: number;
  audioItem: (pcm: Buffer) => OutboundItem;
  markItem: (name: string) => OutboundItem;
  nextMarkName: () => string;
  /** Resolves when the mark came back, the turn was cancelled, or the wait timed out. Must register BEFORE the mark is queued. */
  waitForPlayback: (name: string, timeoutMs: number, turn: TurnContext) => Promise<void>;
}

type Mode = "stream" | "batch";

export class StreamingSpeaker {
  private readonly d: StreamingSpeakerDeps;
  private readonly sentences: string[] = [];
  private voice: string | undefined;
  private mode: Mode = "stream";
  private session: TtsStreamingSession | null = null;
  private gen = 0;
  private nextToSend = 0;
  private completed = 0;
  private finished = false;
  private cancelled = false;
  private ended = false; // completion reached (success or terminal failure)
  private triedDefaultVoice = false;
  private batchRunning = false;
  private batchIndex = 0;

  private audioBytes = 0; // received from TTS (all of it is delivered or held)
  private residual: Buffer = Buffer.alloc(0);
  private began = false;
  private queuedAny = false;
  private held: OutboundItem[] = [];
  private heldBytes = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private completionResolve!: () => void;
  private readonly completion = new Promise<void>((r) => (this.completionResolve = r));
  private readonly onAbort = () => this.cancel();

  /** The first failure that ended (or truncated) the reply, if any. */
  error: unknown;
  /** How the reply was produced, for metrics. */
  fallback: "voice" | "batch" | undefined;

  constructor(deps: StreamingSpeakerDeps) {
    this.d = deps;
    this.voice = deps.voice;
    if (deps.turn.signal.aborted) {
      this.cancelled = true;
      this.completionResolve();
    } else deps.turn.signal.addEventListener("abort", this.onAbort, { once: true });
    if (!this.cancelled) this.openStream();
  }

  get sentenceCount(): number {
    return this.sentences.length;
  }

  /** Submits the next sentence of the reply. Order is the order of calls. Never throws. */
  push(text: string): void {
    const t = text.trim();
    if (!t || this.cancelled || this.finished || this.ended) return;
    if (this.sentences.length === 0) this.d.turn.metrics.mark("ttsStart");
    this.sentences.push(t);
    if (this.mode === "stream") this.pump();
    else void this.runBatch();
  }

  /** No more sentences: resolves once everything pushed was synthesized and PLAYED (or the turn was cancelled / failed). */
  async finish(): Promise<void> {
    this.finished = true;
    this.checkComplete();
    await this.completion;
    try {
      if (!this.cancelled) await this.finalizeAudio();
    } finally {
      this.dispose();
    }
  }

  /** Stops everything for this reply. Idempotent. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.dispose();
    if (this.queuedAny) this.d.sender.clear(this.d.generation); // audio of this (cancelled) reply that is still queued is never sent
    this.completionResolve();
  }

  /** Releases the provider session, timers and listeners. Safe to call repeatedly; does not clear queued audio. */
  dispose(): void {
    this.gen++; // events from the old session are ignored from now on
    this.d.turn.signal.removeEventListener("abort", this.onAbort);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (this.cancelled) {
      this.held = [];
      this.heldBytes = 0;
    }
    const s = this.session;
    this.session = null;
    if (s) {
      if (this.cancelled || this.error) s.cancel();
      else void s.close().catch(() => undefined);
    }
  }

  // ---- streaming path ----------------------------------------------------------------------------------------

  private openStream(): void {
    const gen = ++this.gen;
    this.session = null;
    this.nextToSend = 0;
    this.completed = 0;
    const live = () => gen === this.gen && !this.cancelled && !this.ended;
    this.d.tts
      .startStreaming!(
        {
          onAudio: (pcm) => live() && this.onAudio(pcm),
          onSegmentComplete: () => {
            if (!live()) return;
            this.completed++;
            this.checkComplete();
          },
          onError: (err) => live() && this.onStreamError(err),
          onClose: () => undefined,
        },
        { sampleRate: this.d.sampleRate, languageCode: this.d.languageCode, voice: this.voice, signal: this.d.turn.signal, callId: this.d.callId },
      )
      .then(
        (s) => {
          if (!live()) return s.cancel();
          this.session = s;
          this.pump();
        },
        (err) => live() && this.onStreamError(err),
      );
  }

  /** Sends every not-yet-sent sentence, in order. */
  private pump(): void {
    const s = this.session;
    if (!s || this.mode !== "stream") return;
    while (this.nextToSend < this.sentences.length) {
      if (!s.sendText(this.sentences[this.nextToSend])) return; // dead session: its onError decides what happens
      this.nextToSend++;
    }
  }

  private onStreamError(err: unknown): void {
    const category = err instanceof ProviderRequestError ? err.category : undefined;
    if (this.audioBytes === 0 && this.mode === "stream") {
      this.session?.cancel();
      this.session = null;
      if (category === "invalid_request" && this.voice && !this.triedDefaultVoice) {
        // Same rule as synthesizeWithVoice: a rejected voice is answered with ONE retry on the provider default.
        this.triedDefaultVoice = true;
        this.fallback = "voice";
        logger.warn("tts: configured voice was rejected by the provider, using its default voice", { voiceRejected: true, callId: this.d.callId });
        this.voice = undefined;
        this.openStream();
        return;
      }
      if (category !== "cancelled") {
        // Nothing was heard, so the reply can safely be produced another way (batch synthesis has its own retry + breaker).
        this.mode = "batch";
        this.fallback = "batch";
        this.completed = 0;
        this.gen++;
        logger.warn("tts: streaming failed before any audio, using batch synthesis for this reply", { category, callId: this.d.callId });
        void this.runBatch();
        return;
      }
    }
    this.fail(err);
  }

  // ---- batch fallback ----------------------------------------------------------------------------------------

  /** Sentences one at a time through the batch API, in order, on the same output path. */
  private async runBatch(): Promise<void> {
    if (this.batchRunning) return;
    this.batchRunning = true;
    try {
      while (!this.cancelled && !this.ended && this.batchIndex < this.sentences.length) {
        const text = this.sentences[this.batchIndex++];
        const r = await synthesizeWithVoice(this.d.tts, text, {
          sampleRate: this.d.sampleRate,
          languageCode: this.d.languageCode,
          voice: this.voice,
          signal: this.d.turn.signal,
          callId: this.d.callId,
        });
        if (this.cancelled || this.ended) return;
        this.onAudio(ttsAudioToPcm(r.audio, r.format, this.d.sampleRate));
        this.completed++;
      }
    } catch (err) {
      if (!this.cancelled) this.fail(err);
      return;
    } finally {
      this.batchRunning = false;
    }
    this.checkComplete();
  }

  // ---- audio out ---------------------------------------------------------------------------------------------

  private onAudio(pcm: Buffer): void {
    if (this.cancelled || this.ended || pcm.length === 0) return;
    if (!this.d.sender.isCurrent(this.d.generation)) return this.cancel(); // the output moved on (barge-in): this reply is dead
    if (!this.began) {
      this.d.turn.metrics.mark("ttsFirstAudio");
      if (!this.d.turn.beginAiSpeaking()) {
        this.cancel();
        return;
      }
      this.began = true;
    }
    this.audioBytes += pcm.length;
    this.residual = this.residual.length ? Buffer.concat([this.residual, pcm]) : pcm;
    const items: OutboundItem[] = [];
    while (this.residual.length >= EXOTEL_MIN_CHUNK_BYTES) {
      items.push(this.d.audioItem(this.residual.subarray(0, EXOTEL_MIN_CHUNK_BYTES)));
      this.residual = this.residual.subarray(EXOTEL_MIN_CHUNK_BYTES);
    }
    if (items.length) this.enqueue(items);
  }

  private enqueue(items: OutboundItem[]): void {
    if (this.cancelled) return;
    if (this.held.length === 0 && this.d.sender.enqueue(items, this.d.generation)) {
      this.queuedAny = true;
      return;
    }
    // The outbound queue is full: keep order by holding everything behind what is already held, bounded.
    const weight = items.reduce((n, i) => n + i.weight, 0);
    if (this.heldBytes + weight > this.d.maxHeldBytes) {
      this.held = []; // audio cannot be played out of sequence: what is queued already plays, the rest is dropped
      this.heldBytes = 0;
      this.fail(new Error("Outbound audio queue is full; the reply was cut short"));
      return;
    }
    this.held.push(...items);
    this.heldBytes += weight;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.cancelled) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainHeld();
    }, DRAIN_RETRY_MS);
    this.drainTimer.unref?.();
  }

  private drainHeld(): void {
    while (this.held.length > 0 && !this.cancelled) {
      const item = this.held[0];
      if (!this.d.sender.isCurrent(this.d.generation)) return this.cancel();
      if (!this.d.sender.enqueue([item], this.d.generation)) break;
      this.queuedAny = true;
      this.held.shift();
      this.heldBytes -= item.weight;
    }
    if (this.held.length > 0 && !this.cancelled) this.scheduleDrain();
  }

  /** Everything is synthesized: pad the tail, queue the playback mark behind the audio, wait for playback. */
  private async finalizeAudio(): Promise<void> {
    if (this.audioBytes === 0) return;
    const tail = chunkPcmForExotel(this.residual);
    const totalBytes = this.audioBytes - this.residual.length + tail.reduce((n, c) => n + c.length, 0);
    this.residual = Buffer.alloc(0);
    const audioMs = pcmDurationMs(totalBytes, this.d.sampleRate);
    const name = this.d.nextMarkName();
    const played = this.d.waitForPlayback(name, audioMs + PLAYBACK_GRACE_MS, this.d.turn);
    const items = [...tail.map((c) => this.d.audioItem(c)), this.d.markItem(name)];
    if (this.held.length === 0 && this.d.sender.enqueue(items, this.d.generation)) this.queuedAny = true;
    else {
      this.held.push(...items); // the mark weighs nothing; the tail is at most one chunk past the cap
      this.heldBytes += items.reduce((n, i) => n + i.weight, 0);
      this.scheduleDrain();
    }
    // Everything held back must reach the outbound queue before this reply may be disposed (dispose stops the drain).
    const deadline = Date.now() + audioMs + PLAYBACK_GRACE_MS;
    while (this.held.length > 0 && !this.cancelled && Date.now() < deadline) await new Promise((r) => setTimeout(r, DRAIN_RETRY_MS));
    if (this.held.length > 0 && !this.cancelled) this.error ??= new Error("Outbound audio queue did not drain; the reply was cut short");
    await played;
  }

  // ---- completion --------------------------------------------------------------------------------------------

  private checkComplete(): void {
    if (this.ended || this.cancelled || !this.finished) return;
    if (this.completed < this.sentences.length) return;
    this.ended = true;
    this.d.turn.metrics.mark("ttsEnd");
    this.completionResolve();
  }

  /** The reply cannot continue. What was already received is still played (finalizeAudio runs after completion). */
  private fail(err: unknown): void {
    if (this.ended || this.cancelled) return;
    this.error = err;
    this.ended = true;
    this.d.turn.metrics.mark("ttsEnd");
    this.session?.cancel();
    this.session = null;
    this.completionResolve();
  }

  /**
   * The sentences the provider has fully synthesized so far: an UPPER bound on what the caller heard (some of that audio
   * may still have been queued when an interruption cleared it). Used to trim the model's history after a barge-in.
   */
  get synthesizedText(): string {
    return this.sentences.slice(0, this.completed).join(" ");
  }

  /** Total audio duration received, for metrics. */
  get audioMs(): number {
    return pcmDurationMs(this.audioBytes, this.d.sampleRate);
  }
}
