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
 *  - Turn deadline: a caller turn that has produced no outbound audio within `turnDeadlineMs` of the caller finishing
 *    speaking is ABANDONED (see `armDeadline`). The call is not ended; the next turn runs normally.
 */
import type { TurnDetector, VadResult } from "../audio/turn-detector.js";
import { getConfig } from "../config/env.js";
import { metrics as runtimeMetrics } from "../runtime/metrics.js";
import { logger } from "../shared/logger.js";
import { TurnMetrics, type TurnIds, type TurnKind } from "./turn-metrics.js";
import { TurnStateMachine, type TurnState } from "./turn-state.js";

/** The lower bound `config.realtime.turnDeadlineMs` is clamped to; re-applied here so an injected value is bounded too. */
export const MIN_TURN_DEADLINE_MS = 2000;

/** The reason a turn's signal carries when the turn deadline abandoned it (distinguishable from a barge-in or a hang-up). */
export class TurnDeadlineError extends Error {
  readonly name = "TurnDeadlineError";
  constructor(
    readonly deadlineMs: number,
    readonly elapsedMs: number,
  ) {
    super(`turn abandoned: no outbound audio within ${deadlineMs} ms`);
  }
}

/** Which stage an abandoned turn was still waiting on. Short fixed tokens: these are metric label values. */
export type TurnDeadlineStage = "stt" | "llm" | "tts";

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
  bargeIn?: {
    enabled: boolean;
    minSpeechMs: number;
    /** The caller's voiced level must be this many times the noise floor (0 or absent = no level check). */
    energyRatio?: number;
  };
  /** Finished caller utterances allowed to wait behind the turn in flight. Default 2. */
  maxPendingUtterances?: number;
  /**
   * A caller turn that has produced no outbound audio this many ms after the caller stopped speaking is abandoned.
   * Defaults to `config.realtime.turnDeadlineMs` (REALTIME_TURN_DEADLINE_MS) so every call gets the deadline without
   * each call site having to remember it; clamped to >= MIN_TURN_DEADLINE_MS either way.
   */
  turnDeadlineMs?: number;
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
  noiseFloor?: number;
  voicedRms?: number;
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
  /** Caller turns the turn deadline gave up on. */
  deadlineAbandoned: number;
}

export class TurnController {
  private readonly machine: TurnStateMachine;
  private readonly now: () => number;
  private readonly log: TurnLogger;
  private readonly bargeIn: { enabled: boolean; minSpeechMs: number; energyRatio?: number };
  private readonly maxPending: number;
  /** The effective (clamped) turn deadline in ms. */
  readonly turnDeadlineMs: number;
  private pending: PendingUtterance[] = [];
  private current: { ctx: TurnContext; abort: AbortController; done: Promise<void> } | null = null;
  /** The armed deadline for the turn in flight, if any. At most one: at most one turn is ever in flight. */
  private deadline: { ctx: TurnContext; timer: ReturnType<typeof setTimeout> } | null = null;
  private turnSeq = 0;
  private speechStartAt: number | undefined;
  private closed = false;
  readonly stats: TurnControllerStats = { framesIn: 0, turnsStarted: 0, interruptions: 0, droppedUtterances: 0, deadlineAbandoned: 0 };

  constructor(private readonly opts: TurnControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? logger;
    this.bargeIn = opts.bargeIn ?? { enabled: false, minSpeechMs: 300 };
    this.maxPending = Math.max(1, opts.maxPendingUtterances ?? 2);
    this.turnDeadlineMs = Math.max(MIN_TURN_DEADLINE_MS, Math.round(opts.turnDeadlineMs ?? getConfig().realtime.turnDeadlineMs));
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
        this.maybeBargeIn(r);
        return;
      case "speech":
        this.userActivity();
        this.enterUserSpeaking();
        this.maybeBargeIn(r);
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
        this.maybeBargeIn(r);
        this.enqueueUtterance({
          noiseFloor: r.noiseFloor,
          voicedRms: r.voicedRms,
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
  cancelCurrent(reason: string | Error = "cancelled"): boolean {
    if (!this.current) return false;
    this.current.ctx.metrics.cancelled = true;
    this.current.abort.abort(reason instanceof Error ? reason : new Error(reason));
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
    this.clearDeadline();
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

  private maybeBargeIn(r: VadResult): void {
    if (!this.bargeIn.enabled || r.speechMs < this.bargeIn.minSpeechMs) return;
    // Interrupting needs a clearly strong voice, not just duration: room talk and echo are long but not louder than the
    // room. Only checked once the room's noise floor is known (a silent line has none).
    const ratio = this.bargeIn.energyRatio ?? 0;
    if (ratio > 0 && (r.noiseFloor ?? 0) > 0 && (r.voicedRms ?? 0) < (r.noiseFloor ?? 0) * ratio) return;
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
      turn.metrics.noiseFloor = item.noiseFloor;
      turn.metrics.voicedRms = item.voicedRms;
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
        // Audio is going out: the deadline bounded the wait for exactly this, so it is done. (Disarming here rather
        // than only checking at fire time keeps a turn that speaks and then finishes playing out of reach of it.)
        this.clearDeadline();
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
    // Armed only now: `run` has already stamped `speechEnd` (startNext does it first), and a turn that threw
    // synchronously has already settled — `finish` cleared `current` and there is nothing left to abandon.
    if (this.current?.ctx === ctx) {
      this.current.done = done;
      this.armDeadline(ctx);
    }
    return done;
  }

  // ---- turn deadline ---------------------------------------------------------------------------------------
  //
  // Why here: the controller is the only place that owns ALL of (a) the turn's AbortController — cancelling is how
  // in-flight STT / LLM / TTS work is stopped, (b) the "at most one turn in flight" invariant, (c) the state machine
  // that decides whether audio has started, and (d) the TurnMetrics the latency is measured on. A deadline anywhere
  // else (handler, stt-stream, tts-stream) would need a second, parallel cancellation path and could only see one leg
  // of "STT + all LLM hops + TTS".
  //
  // The clock: the deadline is measured from the `speechEnd` STAMP, which is also what `speechEndToFirstAudioMs` in
  // TurnMetrics.summary() is measured from, and it ticks on `this.now` — the controller's injected clock, the same one
  // the metrics use. So "the turn took 12 s" in the logs and "the deadline is 12 s" cannot disagree.

  /** Where the deadline is counted from: the caller finished speaking (an AI turn has no such moment: its start). */
  private deadlineAnchor(ctx: TurnContext): number {
    return ctx.metrics.stamps.speechEnd ?? ctx.metrics.startedAt;
  }

  /**
   * True once this turn has got audio out, or committed to it. `firstAudioByte` is stamped when the first frame
   * actually reaches the transport; AI_SPEAKING is entered just before the first frame is queued (see
   * TurnContext.beginAiSpeaking), so a reply held up by a congested socket still counts as answered and is never
   * abandoned mid-sentence.
   */
  private hasAudioOut(ctx: TurnContext): boolean {
    return ctx.metrics.stamps.firstAudioByte !== undefined || this.machine.state === "AI_SPEAKING";
  }

  /** Starts the deadline for a caller turn. Only caller turns: an agent-initiated greeting answers nobody's question. */
  private armDeadline(ctx: TurnContext): void {
    this.clearDeadline();
    if (this.closed || ctx.kind !== "user" || this.hasAudioOut(ctx)) return;
    const delay = Math.max(0, this.deadlineAnchor(ctx) + this.turnDeadlineMs - this.now());
    const timer = setTimeout(() => this.onDeadline(ctx), delay);
    timer.unref?.(); // a pending deadline must never hold the process open
    this.deadline = { ctx, timer };
  }

  private clearDeadline(): void {
    if (!this.deadline) return;
    clearTimeout(this.deadline.timer);
    this.deadline = null;
  }

  /**
   * The deadline passed with nothing spoken: abandon the turn. This is the plain cancellation path, NOT an
   * interruption — the caller is silent, so the state machine must not claim they are speaking, queued utterances
   * stay (they are the next turn), and `onInterrupt` has nothing to flush because no audio ever went out.
   *
   * Aborting the turn's signal is what cancels the in-flight work: streaming STT marks the utterance `abandoned` and
   * discards a late final (stt-stream.ts), the LLM request and TTS synthesis abort, and a late TTS callback is refused
   * by `beginAiSpeaking()` returning false, so nothing can be spoken after the turn was given up on. `finish()` then
   * returns the session to IDLE and starts whatever the caller said meanwhile.
   */
  private onDeadline(ctx: TurnContext): void {
    if (this.deadline?.ctx !== ctx) return; // a stale timer: this turn's deadline was re-armed or cleared
    this.deadline = null;
    const cur = this.current;
    // Fire once, and only while there is still something to abandon.
    if (this.closed || cur?.ctx !== ctx || cur.abort.signal.aborted || this.hasAudioOut(ctx)) return;

    const elapsedMs = Math.max(0, this.now() - this.deadlineAnchor(ctx));
    const stage = deadlineStage(ctx.metrics);
    this.stats.deadlineAbandoned++;
    ctx.metrics.deadlineExceeded = true;
    runtimeMetrics.inc("realtime_turn_deadline_abandoned_total", { stage });
    // Expected (a provider can hang) but notable (the caller heard silence where an answer belonged), so: warn.
    // Ids, timings and the stage only — never a transcript, a prompt or audio.
    this.log.warn("turn: deadline exceeded, caller turn abandoned", {
      ...this.opts.ids,
      turnId: ctx.turnId,
      stage,
      elapsedMs,
      deadlineMs: this.turnDeadlineMs,
    });
    this.cancelCurrent(new TurnDeadlineError(this.turnDeadlineMs, elapsedMs));
  }

  private finish(ctx: TurnContext): void {
    if (this.deadline?.ctx === ctx) this.clearDeadline();
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

/**
 * The furthest stage an abandoned caller turn reached. The pipeline is STT -> LLM (one hop per tool round) -> TTS, so
 * the last stage that stamped a start is the one it was waiting on; with nothing stamped it never got past STT.
 */
function deadlineStage(m: TurnMetrics): TurnDeadlineStage {
  if (m.stamps.ttsStart !== undefined) return "tts";
  if (m.stamps.llmStart !== undefined) return "llm";
  return "stt";
}
