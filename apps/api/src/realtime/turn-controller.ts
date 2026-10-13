/**
 * TurnController — the provider-neutral heart of the real-time pipeline for ONE call.
 *
 * It owns: the VAD (audio/turn-detector.ts), the turn state machine (turn-state.ts), the per-turn cancellation
 * signal, the bounded queue of finished caller utterances, and the per-turn metrics. It knows nothing about Exotel,
 * Sarvam, WebSockets, STT/LLM/TTS: the handler injects what a turn actually DOES (`runUserTurn`) and what an
 * interruption must clean up (`onInterrupt`).
 *
 * Guarantees:
 *  - At most ONE turn is in flight. A new turn never starts until the previous one has fully settled, so two LLM or
 *    two TTS generations can never overlap, even right after an interruption.
 *  - Every turn has its own AbortSignal (linked to the call-wide one). Cancelling a turn aborts whatever STT / LLM /
 *    TTS request it passed that signal to.
 *  - Memory is bounded: the VAD caps the utterance buffer, and at most `maxPendingUtterances` finished utterances
 *    wait; the oldest is dropped (and counted) beyond that.
 *  - Barge-in (opt-in): caller speech of at least `bargeIn.minSpeechMs` during PROCESSING / AI_SPEAKING cancels the
 *    turn, calls `onInterrupt` (clear outbound audio), discards stale queued utterances and starts listening.
 *    Without it the agent is half-duplex: inbound audio is ignored while the AI speaks.
 */
import type { TurnDetector, VadResult } from "../audio/turn-detector.js";
import { logger } from "../shared/logger.js";
import { TurnMetrics, type TurnIds, type TurnKind } from "./turn-metrics.js";
import { TurnStateMachine, type TurnState } from "./turn-state.js";

export interface TurnContext {
  readonly turnId: string;
  readonly kind: TurnKind;
  /** Aborted when this turn is cancelled, interrupted, or the call ends. Pass it to every provider request. */
  readonly signal: AbortSignal;
  /** True only while this is the controller's current turn and it has not been cancelled. A finished or interrupted turn never is. */
  isActive(): boolean;
  readonly metrics: TurnMetrics;
  /** Whatever `onVadEvent` returned for this turn's speech_end (e.g. a streaming-STT utterance handle). */
  readonly utteranceRef?: unknown;
  /** PROCESSING → AI_SPEAKING. Returns false if the turn was cancelled meanwhile: then send NO audio. */
  beginAiSpeaking(): boolean;
  /** The reply finished playing: AI_SPEAKING → IDLE right now, so caller audio is analysed at once. */
  endAiSpeaking(): void;
}

export interface TurnLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface TurnControllerOptions {
  ids: TurnIds;
  vad: TurnDetector;
  /** Aborts when the whole call ends. */
  callSignal: AbortSignal;
  bargeIn?: { enabled: boolean; minSpeechMs: number };
  /** Finished caller utterances allowed to wait behind the turn in flight. Default 2. */
  maxPendingUtterances?: number;
  /** What a caller turn does: STT → conversation → speak. Must honour `turn.signal`. */
  runUserTurn: (pcm: Buffer, turn: TurnContext) => Promise<void>;
  /** An interruption cancelled `turn`: stop playback / clear queued outbound audio. */
  onInterrupt?: (turn: TurnContext) => void;
  /**
   * Called for every frame the VAD classified as more than plain silence, with that frame. Lets a streaming STT
   * follow the utterance as it happens. The value returned for a `speech_end` event is carried to the turn as
   * `utteranceRef`.
   */
  onVadEvent?: (result: VadResult, frame: Buffer) => unknown;
  /** A queued utterance will never become a turn (queue overflow, interruption, close): release what `onVadEvent` made for it. */
  onUtteranceDropped?: (ref: unknown) => void;
  /** The VAD was reset (the agent started speaking, a turn ended, the call closed): an utterance in progress is abandoned. */
  onVadReset?: () => void;
  /** Caller speech activity (any speech or pause frame); resets silence timers. */
  onUserActivity?: () => void;
  /** The controller is back to idle with nothing queued and the caller silent. */
  onIdle?: () => void;
  /** Extra log fields for a failed turn (e.g. provider error category). Must not include PII. */
  describeError?: (err: unknown) => Record<string, unknown>;
  now?: () => number;
  log?: TurnLogger;
}

interface PendingUtterance {
  pcm: Buffer;
  ref?: unknown;
  speechStartAt?: number;
  speechEndAt: number;
}

export interface TurnControllerStats {
  framesIn: number;
  turnsStarted: number;
  interruptions: number;
  droppedUtterances: number;
}

export class TurnController {
  private readonly machine: TurnStateMachine;
  private readonly now: () => number;
  private readonly log: TurnLogger;
  private readonly bargeIn: { enabled: boolean; minSpeechMs: number };
  private readonly maxPending: number;
  private pending: PendingUtterance[] = [];
  private current: { ctx: TurnContext; abort: AbortController; done: Promise<void> } | null = null;
  private turnSeq = 0;
  private speechStartAt: number | undefined;
  private closed = false;
  readonly stats: TurnControllerStats = { framesIn: 0, turnsStarted: 0, interruptions: 0, droppedUtterances: 0 };

  constructor(private readonly opts: TurnControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? logger;
    this.bargeIn = opts.bargeIn ?? { enabled: false, minSpeechMs: 300 };
    this.maxPending = Math.max(1, opts.maxPendingUtterances ?? 2);
    this.machine = new TurnStateMachine();
  }

  get state(): TurnState {
    return this.machine.state;
  }

  get history() {
    return this.machine.history;
  }

  /** No turn in flight and the caller is not mid-utterance. */
  get isIdle(): boolean {
    return !this.closed && this.machine.state === "IDLE" && !this.current;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get turnInFlight(): boolean {
    return this.current !== null;
  }

  /** Feed one decoded inbound PCM frame (internal audio format, see audio-format.ts). */
  pushAudio(frame: Buffer): void {
    if (this.closed) return;
    // Half-duplex: while the agent is speaking (or doing its own turn) the caller's audio is not analysed.
    const s = this.machine.state;
    if (!this.bargeIn.enabled && (s === "AI_SPEAKING" || (s === "PROCESSING" && this.current?.ctx.kind === "ai"))) return;
    this.stats.framesIn++;

    const r = this.opts.vad.process(frame);
    let ref: unknown;
    if (r.event !== "silence" && this.opts.onVadEvent) {
      try {
        ref = this.opts.onVadEvent(r, frame);
      } catch (err) {
        this.log.warn("turn: onVadEvent failed", { ...this.opts.ids, errorName: errName(err) });
      }
    }
    switch (r.event) {
      case "silence":
        return;
      case "speech_start":
        this.speechStartAt = this.now();
        this.userActivity();
        this.enterUserSpeaking();
        this.maybeBargeIn(r.speechMs);
        return;
      case "speech":
        this.userActivity();
        this.enterUserSpeaking();
        this.maybeBargeIn(r.speechMs);
        return;
      case "pause":
        this.userActivity();
        if (this.machine.state === "USER_SPEAKING") this.go("USER_SILENCE", "pause");
        return;
      case "discarded":
        this.userActivity();
        this.speechStartAt = undefined;
        if (this.machine.state === "USER_SPEAKING" || this.machine.state === "USER_SILENCE") this.go("IDLE", "noise discarded");
        this.maybeIdle();
        return;
      case "speech_end":
        this.userActivity();
        this.maybeBargeIn(r.speechMs);
        this.enqueueUtterance({
          pcm: r.utterance!,
          ref,
          speechStartAt: this.speechStartAt,
          speechEndAt: this.now() - r.trailingSilenceMs,
        });
        this.speechStartAt = undefined;
        return;
    }
  }

  /**
   * Starts a turn the agent initiates itself (greeting, a guard line). Only when fully idle: returns false (and does
   * nothing) otherwise, so it can never talk over a turn in flight. Resolves true when the turn has finished.
   */
  async runAiTurn(run: (turn: TurnContext) => Promise<void>): Promise<boolean> {
    if (!this.isIdle) return false;
    const done = this.begin("ai", undefined, run);
    await done;
    return true;
  }

  /** Cancels the turn in flight (if any) without treating it as a caller interruption. */
  cancelCurrent(reason = "cancelled"): boolean {
    if (!this.current) return false;
    this.current.ctx.metrics.cancelled = true;
    this.current.abort.abort(new Error(reason));
    return true;
  }

  /** Forgets queued caller utterances (e.g. the call is being ended by a guard). */
  dropPending(): number {
    const n = this.pending.length;
    this.discard(this.pending);
    this.pending = [];
    return n;
  }

  /** Call ended: cancel everything, release buffers, refuse further audio. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.cancelCurrent("call closed");
    this.closed = true;
    this.machine.transition("CLOSED", "close");
    this.discard(this.pending);
    this.pending = [];
    this.resetVad();
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private resetVad(): void {
    this.opts.vad.reset();
    try {
      this.opts.onVadReset?.();
    } catch (err) {
      this.log.warn("turn: onVadReset failed", { ...this.opts.ids, errorName: errName(err) });
    }
  }

  private discard(items: PendingUtterance[]): void {
    for (const item of items) {
      try {
        this.opts.onUtteranceDropped?.(item.ref);
      } catch (err) {
        this.log.warn("turn: onUtteranceDropped failed", { ...this.opts.ids, errorName: errName(err) });
      }
    }
  }

  private go(to: TurnState, reason: string): boolean {
    const ok = this.machine.transition(to, reason);
    if (!ok) {
      this.log.warn("turn: illegal state transition refused", { ...this.opts.ids, from: this.machine.state, to, reason });
    }
    return ok;
  }

  private userActivity(): void {
    this.opts.onUserActivity?.();
  }

  private enterUserSpeaking(): void {
    if (this.machine.state === "IDLE" || this.machine.state === "USER_SILENCE") this.go("USER_SPEAKING", "speech");
  }

  private maybeBargeIn(speechMs: number): void {
    if (!this.bargeIn.enabled || speechMs < this.bargeIn.minSpeechMs) return;
    const s = this.machine.state;
    if (this.current && (s === "PROCESSING" || s === "AI_SPEAKING")) this.interruptCurrent("barge_in");
  }

  private interruptCurrent(reason: string): void {
    const turn = this.current;
    if (!turn || !this.go("INTERRUPTED", reason)) return;
    this.stats.interruptions++;
    turn.ctx.metrics.interrupted = true;
    turn.abort.abort(new Error(reason));
    try {
      this.opts.onInterrupt?.(turn.ctx);
    } catch (err) {
      this.log.warn("turn: onInterrupt failed", { ...this.opts.ids, turnId: turn.ctx.turnId, errorName: errName(err) });
    }
    // Utterances queued before this moment are stale: the caller just spoke over the conversation.
    this.stats.droppedUtterances += this.pending.length;
    this.discard(this.pending);
    this.pending = [];
    this.go("USER_SPEAKING", "after interrupt");
  }

  private enqueueUtterance(item: PendingUtterance): void {
    if (this.pending.length >= this.maxPending) {
      this.discard([this.pending.shift()!]);
      this.stats.droppedUtterances++;
      if (this.current) this.current.ctx.metrics.droppedUtterances++;
      this.log.warn("turn: utterance queue full, oldest dropped", { ...this.opts.ids, maxPending: this.maxPending });
    }
    this.pending.push(item);
    if (!this.current && (this.machine.state === "USER_SPEAKING" || this.machine.state === "USER_SILENCE" || this.machine.state === "IDLE")) {
      this.startNext();
    }
  }

  private startNext(): void {
    if (this.closed || this.current || this.pending.length === 0) return;
    const item = this.pending.shift()!;
    this.begin("user", item.ref, (turn) => {
      if (item.speechStartAt !== undefined) turn.metrics.mark("speechStart", item.speechStartAt);
      turn.metrics.mark("speechEnd", item.speechEndAt);
      return this.opts.runUserTurn(item.pcm, turn);
    });
  }

  private begin(kind: TurnKind, utteranceRef: unknown, run: (turn: TurnContext) => Promise<void>): Promise<void> {
    const abort = new AbortController();
    const onCallAbort = () => abort.abort(this.opts.callSignal.reason);
    if (this.opts.callSignal.aborted) abort.abort(this.opts.callSignal.reason);
    else this.opts.callSignal.addEventListener("abort", onCallAbort, { once: true });

    const turnId = `${this.opts.ids.callId.slice(0, 8)}-t${++this.turnSeq}`;
    const metrics = new TurnMetrics(turnId, kind, this.opts.ids, this.now);
    const ctx: TurnContext = {
      turnId,
      kind,
      signal: abort.signal,
      isActive: () => this.current?.ctx === ctx && !abort.signal.aborted,
      metrics,
      utteranceRef,
      beginAiSpeaking: () => {
        if (this.current?.ctx !== ctx || abort.signal.aborted) return false;
        if (!this.go("AI_SPEAKING", "first audio")) return false;
        if (!this.bargeIn.enabled) this.resetVad();
        return true;
      },
      endAiSpeaking: () => {
        if (this.current?.ctx !== ctx || this.machine.state !== "AI_SPEAKING") return;
        if (!this.bargeIn.enabled) this.resetVad();
        this.go("IDLE", "playback finished");
      },
    };
    this.stats.turnsStarted++;
    this.go("PROCESSING", kind === "user" ? "utterance complete" : "agent turn");
    // Registered BEFORE `run` starts: `run` may call beginAiSpeaking() synchronously.
    this.current = { ctx, abort, done: Promise.resolve() };

    const done = (async () => {
      try {
        await run(ctx);
      } catch (err) {
        if (abort.signal.aborted) {
          if (!metrics.interrupted) metrics.cancelled = true;
        } else {
          metrics.outcome = "error";
          metrics.errorName = errName(err);
          const extra = this.opts.describeError?.(err) ?? {};
          if (typeof extra.category === "string") metrics.errorCategory = extra.category;
          this.log.warn("turn: failed", { ...this.opts.ids, turnId, errorName: metrics.errorName, ...extra });
        }
      } finally {
        this.opts.callSignal.removeEventListener("abort", onCallAbort);
        this.finish(ctx);
      }
    })();
    if (this.current?.ctx === ctx) this.current.done = done;
    return done;
  }

  private finish(ctx: TurnContext): void {
    const m = ctx.metrics;
    m.endedAt = this.now();
    if (m.interrupted) m.outcome = "interrupted";
    // An outcome the turn itself recorded (completed / empty / error) stands even if the call was ended by the turn's own
    // last act (e.g. the agent hanging up): that is not a cancellation.
    else if (m.cancelled || (ctx.signal.aborted && m.outcome === undefined)) {
      m.cancelled = true;
      m.outcome = "cancelled";
    } else m.outcome ??= "completed";
    this.log.info("turn: finished", m.summary());

    if (this.current?.ctx === ctx) this.current = null;
    if (this.closed) return;

    const s = this.machine.state;
    if (s === "PROCESSING" || s === "AI_SPEAKING") {
      if (s === "AI_SPEAKING" && !this.bargeIn.enabled) this.resetVad();
      this.go("IDLE", "turn finished");
      // The caller may already be talking again (spoke over the thinking phase in half-duplex mode).
      if (this.opts.vad.speaking) this.go("USER_SPEAKING", "speech in progress");
    }
    this.startNext();
    this.maybeIdle();
  }

  private maybeIdle(): void {
    if (!this.closed && !this.current && this.pending.length === 0 && this.machine.state === "IDLE" && !this.opts.vad.speaking) {
      this.opts.onIdle?.();
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
