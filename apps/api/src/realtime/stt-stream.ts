/**
 * SttStreamCoordinator — connects the turn pipeline's VAD events to a streaming STT session, per call.
 *
 * It is provider-NEUTRAL: it speaks only the ISpeechToText streaming interface (adapters/ai/stt.interface.ts). It
 * knows nothing about Sarvam's protocol, Exotel, or the conversation; the TurnController keeps ownership of turns.
 *
 *   VAD events ──onVadEvent──▶ coordinator ──startUtterance / sendAudio / endUtterance──▶ session
 *   session.onPartial / onFinal ──▶ coordinator ──awaitFinal(ref)──▶ the user turn
 *
 * Rules it enforces:
 *  - Noise never reaches the provider: audio is held locally until the utterance has `minSpeechMs` of voiced audio
 *    (the same threshold the VAD uses to accept an utterance), then the held audio (pre-roll included) is sent and the
 *    rest streams as it arrives. A blip the VAD discards sends nothing.
 *  - One session per call, opened lazily on the first real utterance and re-opened for the next utterance if it died.
 *    A dead session fails the utterances that were on it. NOTHING is replayed on a new session.
 *  - Partials are transient: counted and timed, their text is never stored or acted on.
 *  - Exactly one final per utterance. A repeated final (same provider utterance index) is ignored. Finals resolve
 *    utterances strictly in the order their speech_end was sent; a final nobody is waiting for is discarded.
 *  - A turn that is cancelled stops waiting at once; its late final is consumed and thrown away (alignment is kept).
 *  - If a final does not arrive within the timeout, the whole session is cancelled (a late final could otherwise be
 *    attributed to the wrong utterance) and the turn fails.
 *  - Memory is bounded: the local hold is at most `minSpeechMs` + pre-roll of audio; ops queued while the session is
 *    opening are capped by `maxQueuedBytes`; the provider session has its own cap.
 */
import type { VadResult } from "../audio/turn-detector.js";
import type { ISpeechToText, SttStreamingSession } from "../adapters/ai/stt.interface.js";
import { ProviderConfigError, ProviderRequestError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import type { TurnMetrics } from "./turn-metrics.js";

export interface SttFinal {
  text: string;
  languageCode?: string;
}

export interface SttStreamCoordinatorOptions {
  stt: ISpeechToText;
  ids: { callId: string; agentId?: string; organizationId?: string };
  sampleRate: number;
  languageCode?: string;
  /** Voiced audio an utterance needs before anything is sent to the provider. Match the VAD's minSpeechMs. */
  minSpeechMs: number;
  /** How long to wait for the final after speech_end before giving up on the session. */
  finalTimeoutMs: number;
  maxQueuedBytes: number;
  /** Aborts when the call ends: every session is cancelled. */
  callSignal: AbortSignal;
  now?: () => number;
  log?: Pick<typeof logger, "info" | "warn">;
}

export interface SttStreamStats {
  sessionsOpened: number;
  utterancesSent: number;
  partials: number;
  finals: number;
  emptyFinals: number;
  duplicateFinals: number;
  unexpectedFinals: number;
  errors: number;
  timeouts: number;
  abandoned: number;
}

type UState = "held" | "streaming" | "ended" | "done";

/** The handle returned for a speech_end; passed back to awaitFinal / drop. Opaque to everyone else. */
export class SttUtterance {
  state: UState = "held";
  held: Buffer[] = [];
  heldBytes = 0;
  speechStartAt: number;
  speechEndAt?: number;
  firstPartialAt?: number;
  finalAt?: number;
  partials = 0;
  /// The turn stopped caring (cancelled / dropped): its result is discarded, but it keeps its place in line.
  abandoned = false;
  sess?: Sess;
  outcome?: { ok: true; value: SttFinal } | { ok: false; error: Error };
  waiter?: { resolve: (v: SttFinal) => void; reject: (e: Error) => void };

  constructor(readonly id: number, startAt: number) {
    this.speechStartAt = startAt;
  }
}

/** One provider session and the utterances on it, oldest first. */
interface Sess {
  id: number;
  startedAt: number;
  session?: SttStreamingSession;
  /** Operations issued before startStreaming resolved. */
  ops: Array<{ run: (s: SttStreamingSession) => boolean; bytes: number }>;
  opsBytes: number;
  utterances: SttUtterance[];
  seenFinal: Set<number>;
  dead: boolean;
  partials: number;
  finals: number;
}

export class SttStreamCoordinator {
  private readonly now: () => number;
  private readonly log: Pick<typeof logger, "info" | "warn">;
  private sess: Sess | null = null;
  private current: SttUtterance | null = null;
  private seq = 0;
  private sessSeq = 0;
  private closed = false;
  readonly stats: SttStreamStats = {
    sessionsOpened: 0,
    utterancesSent: 0,
    partials: 0,
    finals: 0,
    emptyFinals: 0,
    duplicateFinals: 0,
    unexpectedFinals: 0,
    errors: 0,
    timeouts: 0,
    abandoned: 0,
  };
  private readonly onCallAbort = () => this.close();

  constructor(private readonly o: SttStreamCoordinatorOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? logger;
    if (o.callSignal.aborted) this.closed = true;
    else o.callSignal.addEventListener("abort", this.onCallAbort, { once: true });
  }

  get hasOpenSession(): boolean {
    return !!this.sess && !this.sess.dead;
  }

  // ---- VAD side --------------------------------------------------------------------------------------------

  /** Pass to TurnController.onVadEvent. Returns the utterance handle for `speech_end`. */
  onVadEvent = (r: VadResult, frame: Buffer): SttUtterance | undefined => {
    if (this.closed) return undefined;
    switch (r.event) {
      case "speech_start": {
        this.abandonCurrent(); // a new utterance while one is open should not happen; never leave one dangling
        const u = new SttUtterance(++this.seq, this.now());
        this.current = u;
        this.hold(u, r.leadAudio ?? frame);
        this.maybeConfirm(u, r.speechMs);
        return undefined;
      }
      case "speech":
      case "pause": {
        const u = this.current;
        if (!u) return undefined;
        if (u.state === "held") {
          this.hold(u, frame);
          this.maybeConfirm(u, r.speechMs);
        } else if (u.state === "streaming") this.audio(u, frame);
        return undefined;
      }
      case "discarded": {
        const u = this.current;
        this.current = null;
        if (u?.state === "held") this.release(u); // noise: nothing was ever sent
        else if (u) this.endOrphan(u, frame);
        return undefined;
      }
      case "speech_end": {
        const u = this.current;
        this.current = null;
        if (!u) return undefined;
        if (u.state === "held") this.confirm(u); // forced end before the threshold was crossed: still a real utterance
        if (u.state !== "streaming") return u; // the session already failed; awaitFinal will report it
        this.audio(u, frame);
        this.endUtterance(u);
        return u;
      }
      default:
        return undefined;
    }
  };

  /** The VAD was reset under an utterance in progress (the agent started speaking): finish it without a turn. */
  onVadReset = (): void => {
    this.abandonCurrent();
  };

  /** The controller will not make a turn from this utterance. */
  drop = (ref: unknown): void => {
    if (!(ref instanceof SttUtterance) || ref.state === "done") return;
    this.stats.abandoned++;
    ref.abandoned = true;
    if (ref.state === "held") this.release(ref);
  };

  // ---- turn side -------------------------------------------------------------------------------------------

  /**
   * The final transcript for the utterance behind `ref`. Rejects with the provider error if its session failed, with
   * a timeout error if the final is overdue (and the session is cancelled), and with `signal.reason` if the turn is
   * cancelled first. Stamps STT timings on `metrics`.
   */
  awaitFinal(ref: unknown, signal: AbortSignal, metrics?: TurnMetrics): Promise<SttFinal> {
    if (!(ref instanceof SttUtterance)) {
      return Promise.reject(new ProviderRequestError("stt", "stt stream: no utterance was captured for this turn", undefined, { category: "internal", operation: "stt.stream" }));
    }
    const u = ref;
    const stamp = (value?: SttFinal) => this.stamp(u, metrics, value);
    return new Promise<SttFinal>((resolve, reject) => {
      const timer: { id?: ReturnType<typeof setTimeout> } = {};
      const cleanup = () => {
        if (timer.id) clearTimeout(timer.id);
        signal.removeEventListener("abort", onAbort);
        u.waiter = undefined;
      };
      const onAbort = () => {
        cleanup();
        this.stats.abandoned++;
        u.abandoned = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
      };
      const settle = (r: NonNullable<SttUtterance["outcome"]>) => {
        cleanup();
        stamp(r.ok ? r.value : undefined);
        if (r.ok) resolve(r.value);
        else reject(r.error);
      };
      if (signal.aborted) return onAbort();
      if (u.outcome) return settle(u.outcome);
      signal.addEventListener("abort", onAbort, { once: true });
      u.waiter = {
        resolve: (v) => settle({ ok: true, value: v }),
        reject: (e) => settle({ ok: false, error: e }),
      };
      timer.id = setTimeout(() => {
        this.stats.timeouts++;
        const err = new ProviderRequestError("stt", "stt stream: the final transcript did not arrive in time", undefined, { category: "timeout", operation: "stt.stream" });
        // A late final could be attributed to the next utterance: give up on the whole session.
        if (u.sess) this.killSession(u.sess, err);
        else settle({ ok: false, error: err });
      }, this.o.finalTimeoutMs);
      timer.id.unref?.();
    });
  }

  /** Call ended: cancel every session, fail every waiter, release buffers. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.o.callSignal.removeEventListener("abort", this.onCallAbort);
    const cancelled = new Error("The call ended");
    cancelled.name = "AbortError";
    if (this.current) this.release(this.current);
    this.current = null;
    if (this.sess) this.killSession(this.sess, cancelled, true);
    this.sess = null;
    const s = this.stats;
    this.log.info("stt stream: call summary", {
      ...this.o.ids,
      provider: this.o.stt.name,
      sessions: s.sessionsOpened,
      utterances: s.utterancesSent,
      partials: s.partials,
      finals: s.finals,
      emptyFinals: s.emptyFinals,
      emptyRate: s.finals ? Number((s.emptyFinals / s.finals).toFixed(3)) : 0,
      duplicateFinals: s.duplicateFinals,
      unexpectedFinals: s.unexpectedFinals,
      errors: s.errors,
      timeouts: s.timeouts,
      cancelledTurns: s.abandoned,
    });
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private hold(u: SttUtterance, audio: Buffer): void {
    u.held.push(audio);
    u.heldBytes += audio.length;
  }

  private release(u: SttUtterance): void {
    u.held = [];
    u.heldBytes = 0;
    u.state = "done";
  }

  private maybeConfirm(u: SttUtterance, speechMs: number): void {
    if (u.state === "held" && speechMs >= this.o.minSpeechMs) this.confirm(u);
  }

  /** The utterance is real speech: make sure there is a session, announce it, and flush what was held. */
  private confirm(u: SttUtterance): void {
    const sess = this.ensureSession();
    u.sess = sess;
    sess.utterances.push(u);
    u.state = "streaming";
    this.stats.utterancesSent++;
    const held = u.held;
    u.held = [];
    u.heldBytes = 0;
    this.issue(sess, 0, (s) => s.startUtterance());
    for (const chunk of held) this.audio(u, chunk);
  }

  private audio(u: SttUtterance, pcm: Buffer): void {
    if (!u.sess || u.sess.dead) return;
    this.issue(u.sess, pcm.length, (s) => s.sendAudio(pcm));
  }

  private endUtterance(u: SttUtterance): void {
    if (!u.sess || u.sess.dead) return;
    u.state = "ended";
    u.speechEndAt = this.now();
    this.issue(u.sess, 0, (s) => s.endUtterance());
  }

  /** The utterance began streaming but will never become a turn: close it off so the provider's reply stays in step. */
  private endOrphan(u: SttUtterance, lastFrame?: Buffer): void {
    u.abandoned = true;
    this.stats.abandoned++;
    if (u.state !== "streaming") return;
    if (lastFrame) this.audio(u, lastFrame);
    this.endUtterance(u);
  }

  private abandonCurrent(): void {
    const u = this.current;
    this.current = null;
    if (!u) return;
    if (u.state === "held") this.release(u);
    else this.endOrphan(u);
  }

  private ensureSession(): Sess {
    if (this.sess && !this.sess.dead) return this.sess;
    const sess: Sess = {
      id: ++this.sessSeq,
      startedAt: this.now(),
      ops: [],
      opsBytes: 0,
      utterances: [],
      seenFinal: new Set(),
      dead: false,
      partials: 0,
      finals: 0,
    };
    this.sess = sess;
    this.stats.sessionsOpened++;
    const opening = this.o.stt.startStreaming?.(
      {
        onPartial: (e) => this.onPartial(sess, e.text.length),
        onFinal: (e) => this.onFinal(sess, e),
        onError: (err) => this.killSession(sess, err),
        onClose: () => this.onSessionClosed(sess),
      },
      {
        sampleRate: this.o.sampleRate,
        languageCode: this.o.languageCode,
        signal: this.o.callSignal,
        callId: this.o.ids.callId,
        agentId: this.o.ids.agentId,
        organizationId: this.o.ids.organizationId,
        maxQueuedBytes: this.o.maxQueuedBytes,
      },
    );
    if (!opening) {
      queueMicrotask(() => this.killSession(sess, new ProviderConfigError(this.o.stt.name, "This STT provider does not support streaming")));
      return sess;
    }
    opening.then(
      (session) => {
        if (sess.dead) {
          session.cancel(); // failed or closed while connecting
          return;
        }
        sess.session = session;
        const ops = sess.ops;
        sess.ops = [];
        sess.opsBytes = 0;
        for (const op of ops) {
          if (!op.run(session)) break; // the session refused: its own onError reports why
        }
      },
      (err: unknown) => {
        const e = err instanceof ProviderRequestError || err instanceof ProviderConfigError
          ? err
          : new ProviderRequestError(this.o.stt.name, "stt stream could not be opened", err, { category: "internal", operation: "stt.stream" });
        this.killSession(sess, e);
      },
    );
    return sess;
  }

  /** Runs `run` on the session now, or queues it (bounded) until startStreaming resolves. */
  private issue(sess: Sess, bytes: number, run: (s: SttStreamingSession) => boolean): void {
    if (sess.dead) return;
    if (sess.session) {
      run(sess.session);
      return;
    }
    if (sess.opsBytes + bytes > this.o.maxQueuedBytes) {
      this.killSession(
        sess,
        new ProviderRequestError(this.o.stt.name, "stt stream: audio queue limit reached while connecting", undefined, { category: "internal", operation: "stt.stream" }),
      );
      return;
    }
    sess.ops.push({ run, bytes });
    sess.opsBytes += bytes;
  }

  private onPartial(sess: Sess, textLength: number): void {
    if (sess.dead) return;
    this.stats.partials++;
    sess.partials++;
    const u = sess.utterances[0];
    if (!u) return;
    u.partials++;
    u.firstPartialAt ??= this.now();
    void textLength; // length only; the text itself is never kept
  }

  private onFinal(sess: Sess, e: { text: string; utteranceIdx?: number; languageCode?: string }): void {
    if (sess.dead) return;
    if (e.utteranceIdx !== undefined) {
      if (sess.seenFinal.has(e.utteranceIdx)) {
        this.stats.duplicateFinals++;
        this.log.info("stt stream: duplicate final ignored", { ...this.o.ids, utteranceIdx: e.utteranceIdx });
        return;
      }
      sess.seenFinal.add(e.utteranceIdx);
    }
    const u = sess.utterances[0];
    if (!u || u.state !== "ended") {
      // A final for an utterance we have not finished (or none at all). Manual endpointing should not produce one.
      this.stats.unexpectedFinals++;
      this.log.warn("stt stream: unexpected final ignored", { ...this.o.ids, utteranceIdx: e.utteranceIdx });
      return;
    }
    sess.utterances.shift();
    sess.finals++;
    u.state = "done";
    u.finalAt = this.now();
    this.stats.finals++;
    const text = e.text.trim();
    if (!text) this.stats.emptyFinals++;
    if (u.abandoned) return; // nobody is waiting any more (cancelled turn, orphan): consumed, not delivered
    const value: SttFinal = { text, languageCode: e.languageCode };
    if (u.waiter) u.waiter.resolve(value);
    else u.outcome = { ok: true, value };
  }

  private onSessionClosed(sess: Sess): void {
    if (sess.dead) return;
    // Closed without an error and with answers still owed (idle close, provider hang-up): those utterances are lost.
    this.killSession(
      sess,
      new ProviderRequestError(this.o.stt.name, "stt stream closed before the final transcript", undefined, { category: "network", operation: "stt.stream" }),
      sess.utterances.length === 0,
    );
  }

  /** Marks the session dead, fails everything still waiting on it, and releases it. */
  private killSession(sess: Sess, error: Error, quiet = false): void {
    if (sess.dead) return;
    sess.dead = true;
    if (this.sess === sess) this.sess = null;
    // Session end, for provider comparison: how long it lived and what it produced. No text.
    this.log.info("stt stream: session ended", {
      ...this.o.ids,
      provider: this.o.stt.name,
      sessionMs: this.now() - sess.startedAt,
      partials: sess.partials,
      finals: sess.finals,
      utterancesLost: sess.utterances.length,
      endedBy: quiet ? "closed" : error.name,
      category: error instanceof ProviderRequestError ? error.category : undefined,
    });
    if (!quiet) {
      this.stats.errors++;
      this.log.warn("stt stream: session ended with an error", {
        ...this.o.ids,
        provider: this.o.stt.name,
        errorName: error.name,
        ...(error instanceof ProviderRequestError ? error.toLogFields() : {}),
      });
    }
    sess.ops = [];
    sess.opsBytes = 0;
    try {
      sess.session?.cancel();
    } catch {
      // already gone
    }
    const lost = sess.utterances;
    sess.utterances = [];
    for (const u of lost) {
      u.state = "done";
      if (u.abandoned) continue;
      if (u.waiter) u.waiter.reject(error);
      else u.outcome = { ok: false, error };
    }
    if (this.current?.sess === sess) {
      // The utterance being spoken right now lost its session; the rest of it has nowhere to go.
      this.current.state = "done";
    }
  }

  private stamp(u: SttUtterance, metrics?: TurnMetrics, value?: SttFinal): void {
    if (!metrics) return;
    if (u.sess) metrics.mark("sttSessionStart", u.sess.startedAt);
    if (u.speechEndAt !== undefined) metrics.mark("sttStart", u.speechEndAt);
    if (u.firstPartialAt !== undefined) metrics.mark("firstPartial", u.firstPartialAt);
    metrics.sttPartials = u.partials;
    metrics.sttProvider = this.o.stt.name;
    const at = u.finalAt ?? this.now();
    metrics.mark("finalTranscript", at);
    metrics.mark("sttEnd", at);
    if (value && !value.text) metrics.sttEmpty = true;
  }
}
