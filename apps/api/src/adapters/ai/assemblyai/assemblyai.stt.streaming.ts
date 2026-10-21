/**
 * EXPERIMENTAL — AssemblyAI streaming STT session. ALL AssemblyAI protocol details live in this directory.
 * Delete adapters/ai/assemblyai/ (plus the three small hooks listed in ASSEMBLYAI_EXPERIMENT.md) to remove it.
 *
 * Contract used (AssemblyAI docs, Streaming API v3; verified against the published reference, not against a live account):
 *
 *   URL      wss://streaming.assemblyai.com/v3/ws                    (config: ASSEMBLYAI_STT_URL)
 *   Auth     header  Authorization: <api key>   (no "Bearer"; never in the URL, never logged)
 *   Query    speech_model, encoding=pcm_s16le, sample_rate (any 8000-96000: 8 kHz telephony audio is sent AS IS),
 *            format_turns=true, min_turn_silence, max_turn_silence
 *   Client   binary audio frames of 50-1000 ms; {"type":"ForceEndpoint"}  {"type":"Terminate"}
 *   Server   Begin {id, expires_at, configuration:{model,...}}   SpeechStarted
 *            Turn {turn_order, end_of_turn, turn_is_formatted, transcript, utterance, words[], ...}
 *            Termination {audio_duration_seconds, session_duration_seconds}
 *            Error {error_code, error}
 *   Notes    - unrecognised query parameters are IGNORED by the service, so Begin.configuration.model is checked
 *              against the model we asked for;
 *            - partial Turn (end_of_turn=false) carries the cumulative transcript of the turn so far;
 *            - a turn is complete only when end_of_turn AND turn_is_formatted are both true. Universal Streaming with
 *              format_turns=true sends TWO end_of_turn messages for one turn_order (unformatted, then formatted);
 *            - ForceEndpoint "responds with the end_of_turn: true message(s) immediately";
 *            - after Terminate the client must keep reading until Termination (closing earlier discards the last turn);
 *            - sessions are billed for wall-clock time the socket is open, and need no KeepAlive unless
 *              inactivity_timeout is set (it is not).
 *
 * Audio: our internal PCM s16le mono at the call's rate goes out unchanged. No resampling at all; the only change is
 * re-framing to the 50-1000 ms the service requires (frames shorter than 50 ms are held and joined, longer ones split,
 * the tail of an utterance is padded with silence to 50 ms).
 *
 * Who decides when a turn ends: OUR turn controller. speech_end is sent as ForceEndpoint, and provider-side
 * endpointing is pushed far out (min/max_turn_silence). If the service still ends a turn by itself in the middle of
 * one of our utterances, that final is HELD and joined to the one our ForceEndpoint produces, so the application sees
 * exactly one final per utterance. If ForceEndpoint produces no answer at all (nothing was pending, which the docs do
 * not describe), the held text is settled after `flushGraceMs`. Both behaviours are unverified against the live service.
 *
 * No retries and no replay: a failed connection fails the session; the coordinator opens a new one for the next
 * utterance. Provider message text is never copied into errors or logs.
 */
import WebSocket from "ws";
import type { SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "../stt.interface.js";
import { ProviderRequestError, type ProviderFailureCategory } from "../../../shared/errors.js";
import { categoryForStatus } from "../provider-errors.js";
import { logger } from "../../../shared/logger.js";

export const ASSEMBLYAI_PROVIDER = "assemblyai-stt";
const OPERATION = "stt.stream";
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 1000;
const GRACEFUL_CLOSE_WAIT_MS = 3_000;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;

export interface AssemblyAiStreamConfig {
  apiKey: string;
  url: string;
  model: string;
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  flushGraceMs: number;
  connectTimeoutMs: number;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket;
const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });

/** `Error.error_code` values the docs actually describe. Anything else is a generic server failure. */
function categoryForErrorCode(code: unknown): ProviderFailureCategory {
  if (code === 3006 || code === 3008) return "timeout"; // inactivity / session expiry
  if (code === 3007) return "internal"; // we sent audio faster than it can be processed
  // Documented ("Unauthorized connection: Too many concurrent sessions"): the account's NEW-SESSIONS-PER-MINUTE limit
  // (free tier: 5/min), not an auth problem and not a fault of ours.
  if (code === 1008) return "rate_limited";
  return "server";
}

type Status = "connecting" | "open" | "closing" | "closed";
type Queued = string | Buffer;

interface Waiting {
  parts: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class AssemblyAiSttStreamingSession implements SttStreamingSession {
  private status: Status = "connecting";
  private ready = false;
  private readonly ws: WebSocket;
  private pending: Queued[] = [];
  private pendingBytes = 0;
  private readonly maxQueued: number;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenced = false;
  private closedEmitted = false;
  private closeWaiters: Array<() => void> = [];
  private readonly minBytes: number;
  private readonly maxBytes: number;
  private carry: Buffer = Buffer.alloc(0);
  /** Our utterance in progress: provider finals that arrive before we end it are held here. */
  private current: Waiting | null = null;
  /** Utterances we ended and sent ForceEndpoint for, oldest first; provider finals answer them in order. */
  private waiting: Waiting[] = [];
  private readonly seenTurns = new Set<number>();
  private emitted = 0;
  private readonly onAbort = () => this.cancel();

  constructor(
    private readonly cfg: AssemblyAiStreamConfig,
    private readonly handlers: SttStreamHandlers,
    private readonly opts: SttStreamOptions,
    socketFactory: SocketFactory = defaultSocketFactory,
  ) {
    this.maxQueued = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    const bytesPerMs = (opts.sampleRate * 2) / 1000;
    this.minBytes = Math.ceil(bytesPerMs * MIN_FRAME_MS);
    this.maxBytes = Math.floor(bytesPerMs * MAX_FRAME_MS);

    const query = new URLSearchParams({
      speech_model: cfg.model,
      encoding: "pcm_s16le",
      sample_rate: String(opts.sampleRate),
      format_turns: "true",
      min_turn_silence: String(cfg.minTurnSilenceMs),
      max_turn_silence: String(cfg.maxTurnSilenceMs),
    });
    this.ws = socketFactory(`${cfg.url}?${query.toString()}`, { Authorization: cfg.apiKey });

    this.connectTimer = setTimeout(() => this.fail("timeout", "timed out connecting"), cfg.connectTimeoutMs);
    this.connectTimer.unref?.();
    this.ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      this.fail(categoryForStatus(status), `connection refused (HTTP ${status})`, status);
    });
    this.ws.on("error", () => {
      if (this.status === "connecting" || this.status === "open") this.fail("network", "connection error");
    });
    this.ws.on("close", (code) => this.onSocketClose(code));

    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(() => this.cancel());
      else opts.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  get open(): boolean {
    return this.status === "connecting" || this.status === "open";
  }

  startUtterance(): boolean {
    if (!this.open) return false;
    if (!this.current) this.current = { parts: [], timer: null };
    return true;
  }

  sendAudio(pcm: Buffer): boolean {
    if (!this.open) return false;
    if (pcm.length === 0) return true;
    this.carry = this.carry.length === 0 ? pcm : Buffer.concat([this.carry, pcm]);
    while (this.carry.length >= this.maxBytes) {
      if (!this.send(this.carry.subarray(0, this.maxBytes))) return false;
      this.carry = this.carry.subarray(this.maxBytes);
    }
    if (this.carry.length >= this.minBytes) {
      const frame = this.carry;
      this.carry = Buffer.alloc(0);
      return this.send(frame);
    }
    return true; // shorter than 50 ms: held until more audio (or the end of the utterance) arrives
  }

  endUtterance(): boolean {
    if (!this.open) return false;
    const utt = this.current ?? { parts: [], timer: null };
    this.current = null;
    if (!this.flushAudio()) return false;
    if (!this.send(JSON.stringify({ type: "ForceEndpoint" }))) return false;
    utt.timer = setTimeout(() => this.settle(utt), this.cfg.flushGraceMs);
    utt.timer.unref?.();
    this.waiting.push(utt);
    return true;
  }

  close(): Promise<void> {
    if (this.status === "closed") return Promise.resolve();
    const done = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    if (this.status === "closing") return done;
    if (this.flushAudio() && this.send(JSON.stringify({ type: "Terminate" }))) {
      this.status = "closing";
      const t = setTimeout(() => this.teardown(), GRACEFUL_CLOSE_WAIT_MS);
      t.unref?.();
      this.closeWaiters.push(() => clearTimeout(t));
    } else {
      this.teardown();
    }
    return done;
  }

  cancel(): void {
    this.silenced = true;
    this.teardown();
  }

  // ---- internals -------------------------------------------------------------------------------------------

  /** Sends what is held, padded with silence up to the service's 50 ms minimum. */
  private flushAudio(): boolean {
    if (this.carry.length === 0) return true;
    const frame = this.carry.length >= this.minBytes ? this.carry : Buffer.concat([this.carry, Buffer.alloc(this.minBytes - this.carry.length)]);
    this.carry = Buffer.alloc(0);
    return this.send(frame);
  }

  private send(message: Queued): boolean {
    if (this.status !== "connecting" && this.status !== "open") return false;
    const size = typeof message === "string" ? message.length : message.length;
    if (!this.ready) {
      if (this.pendingBytes + size > this.maxQueued) return this.fail("internal", "audio queue limit reached while connecting") && false;
      this.pending.push(message);
      this.pendingBytes += size;
      return true;
    }
    if (this.ws.bufferedAmount + size > this.maxQueued) return this.fail("internal", "socket congested: audio queue limit reached") && false;
    try {
      this.ws.send(message);
      return true;
    } catch {
      this.fail("network", "send failed");
      return false;
    }
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.status === "closed" || this.silenced || isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.fail("bad_response", "provider sent a non-JSON message");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      this.fail("bad_response", "provider sent a message without a type");
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "Begin": {
        const applied = (m.configuration as { model?: unknown } | undefined)?.model;
        // Unrecognised query parameters (a misspelt model name) are ignored by the service, not rejected.
        if (typeof applied === "string" && applied !== this.cfg.model) {
          this.fail("invalid_request", "the service did not apply the requested speech_model");
          return;
        }
        this.onReady();
        return;
      }
      case "Turn":
        this.onTurn(m);
        return;
      case "Termination":
        this.teardown();
        return;
      case "Error":
        // The numeric error_code is safe to keep (it is not content); the message text is not.
        this.fail(categoryForErrorCode(m.error_code), "provider reported an error", typeof m.error_code === "number" ? m.error_code : undefined);
        return;
      default:
        return; // SpeechStarted, Heartbeat, SpeakerRevision, LLMGatewayResponse and anything newer
    }
  }

  private onTurn(m: Record<string, unknown>): void {
    if (typeof m.transcript !== "string" || typeof m.end_of_turn !== "boolean") {
      this.fail("bad_response", "malformed Turn message");
      return;
    }
    const order = typeof m.turn_order === "number" ? m.turn_order : undefined;
    const text = m.transcript.trim();

    if (!m.end_of_turn) {
      if (text) this.deliver(() => this.handlers.onPartial({ text, utteranceIdx: order }));
      return;
    }
    // Complete only when formatted too (an unformatted end_of_turn is followed by the formatted one for the same turn).
    if (m.turn_is_formatted === false) return;
    if (order !== undefined) {
      if (this.seenTurns.has(order)) {
        logger.info("assemblyai stt stream: duplicate final ignored", { callId: this.opts.callId, turnOrder: order });
        return;
      }
      this.seenTurns.add(order);
    }
    this.onFinalText(text);
  }

  /** A completed provider turn: it answers the oldest ended utterance, or is held for the one in progress. */
  private onFinalText(text: string): void {
    const head = this.waiting[0];
    if (head) {
      if (text) head.parts.push(text);
      this.settle(head);
      return;
    }
    if (this.current) {
      // The service ended a turn on its own while the caller is still mid-utterance: hold it; our ForceEndpoint will
      // flush the rest, and the application gets a single final.
      if (text) this.current.parts.push(text);
      return;
    }
    logger.warn("assemblyai stt stream: final with no utterance in progress ignored", { callId: this.opts.callId });
  }

  /** Emits the single final for an ended utterance (exactly once) and removes it from the line. */
  private settle(utt: Waiting): void {
    const i = this.waiting.indexOf(utt);
    if (i < 0) return;
    this.waiting.splice(i, 1);
    if (utt.timer) clearTimeout(utt.timer);
    utt.timer = null;
    const text = utt.parts.join(" ").trim();
    const utteranceIdx = this.emitted++;
    this.deliver(() => this.handlers.onFinal({ text, utteranceIdx }));
  }

  private onReady(): void {
    if (this.ready || this.status === "closed") return;
    this.ready = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.status === "connecting") this.status = "open";
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      for (const q of queued) this.ws.send(q);
    } catch {
      this.fail("network", "send failed");
    }
  }

  private onSocketClose(code: number): void {
    if (this.status === "closed") return;
    if (this.status === "closing") return this.teardown();
    if (code === 1000 || code === 1001 || code === 1005) this.teardown();
    else this.fail("network", `connection closed by provider (code ${code})`);
  }

  private deliver(fn: () => void): void {
    if (this.status === "closed" || this.silenced) return;
    try {
      fn();
    } catch (err) {
      logger.error("assemblyai stt stream: handler threw", { callId: this.opts.callId, errorName: err instanceof Error ? err.name : "UnknownError" });
    }
  }

  private fail(category: ProviderFailureCategory, what: string, status?: number): true {
    if (this.status === "closed") return true;
    const error = new ProviderRequestError(ASSEMBLYAI_PROVIDER, `${ASSEMBLYAI_PROVIDER} ${OPERATION}: ${what}`, undefined, { category, operation: OPERATION, status });
    this.deliver(() => this.handlers.onError(error));
    this.teardown();
    return true;
  }

  private teardown(): void {
    if (this.status === "closed") return;
    this.status = "closed";
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    for (const w of this.waiting) if (w.timer) clearTimeout(w.timer);
    this.waiting = [];
    this.current = null;
    this.carry = Buffer.alloc(0);
    this.pending = [];
    this.pendingBytes = 0;
    this.opts.signal?.removeEventListener("abort", this.onAbort);
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
    if (!this.closedEmitted) {
      this.closedEmitted = true;
      try {
        this.handlers.onClose();
      } catch {
        // a throwing handler must not break teardown
      }
    }
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of waiters) w();
  }
}
