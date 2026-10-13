/**
 * Sarvam realtime (streaming) STT session. ALL Sarvam realtime-protocol details live in this file.
 *
 * Contract used (Sarvam docs: api-reference/speech-to-text/transcribe/realtime/ws and the "Realtime Streaming" guide):
 *
 *   URL      wss://api.sarvam.ai/speech-to-text-realtime/ws          (config: SARVAM_STT_REALTIME_URL)
 *   Auth     header  api-subscription-key: <key>                    (never in the URL, never logged)
 *   Query    language_code  (required; "auto" = detect), model (saaras:v3-realtime | saaras:v4),
 *            stream_type (fast | balanced), mode, endpointing=manual, encoding=linear16, sample_rate=8000|16000
 *   Client   {"event":"audio_input","audio":"<base64 PCM>"}  {"event":"speech_start"}  {"event":"speech_end"}
 *            {"event":"flush"}  {"event":"ping"}  {"event":"end"}
 *   Server   session.begin | vad.speech_start | vad.speech_end | transcript.partial {utterance_idx,text,language?}
 *            transcript.final {utterance_idx,text,language?,...} | session.end | pong | config.updated
 *            | error {code,is_fatal,message,status_code?}
 *   Close    1003 rate limit / quota / invalid key, 1008 inactivity, 1011 server error, 4000 application rejection
 *
 * Design choices that follow from it:
 *  - endpointing=manual: OUR turn pipeline decides when the caller starts/stops speaking (speech_start / speech_end);
 *    Sarvam emits one transcript.final per delimited utterance. Partials are plain interim text.
 *  - Realtime retry is NOT replay: if the connection fails, the session fails. Nothing is re-sent on a new connection
 *    (the caller opens a fresh session for the NEXT utterance).
 *  - Memory is bounded: audio sent while connecting, or while the socket is congested, is capped by maxQueuedBytes;
 *    beyond it the session fails with "backpressure" rather than growing.
 *  - Sarvam realtime takes 8 kHz / 16 kHz; 24 kHz input is resampled here (provider-specific conversion stays here).
 *  - Provider message text is never copied into our errors or logs (it may contain transcript content).
 */
import WebSocket from "ws";
import type { SttStreamHandlers, SttStreamingSession, SttStreamOptions, SttTranscriptEvent } from "./stt.interface.js";
import { ProviderRequestError, type ProviderFailureCategory } from "../../shared/errors.js";
import { categoryForStatus } from "./provider-errors.js";
import { resamplePcm16 } from "../../audio/pcm.js";
import { logger } from "../../shared/logger.js";

const PROVIDER = "sarvam";
const OPERATION = "stt.stream";
const AUDIO_SLICE_BYTES = 3200; // Sarvam's documented example chunk: 100 ms @ 16 kHz
const PING_INTERVAL_MS = 5_000; // inactivity timeout exists (close 1008) but its length is not documented: stay well inside it
const GRACEFUL_CLOSE_WAIT_MS = 2_000;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;

/** Languages the realtime endpoint documents. Anything else falls back to auto-detection (never an invented code). */
const REALTIME_LANGUAGES: ReadonlySet<string> = new Set([
  "en-IN", "hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "or-IN", "pa-IN", "ta-IN", "te-IN", "gu-IN", "as-IN", "ur-IN",
  "ne-IN", "kok-IN", "ks-IN", "sd-IN", "sa-IN", "sat-IN", "mni-IN", "brx-IN", "mai-IN", "doi-IN",
]);

/** Our agent language code -> Sarvam realtime `language_code`. Odia is "od-IN" in the batch API but "or-IN" here. */
export function toRealtimeLanguage(code: string | undefined): { value: string; fellBack: boolean } {
  if (!code) return { value: "auto", fellBack: false };
  const c = code === "od-IN" ? "or-IN" : code;
  return REALTIME_LANGUAGES.has(c) ? { value: c, fellBack: false } : { value: "auto", fellBack: true };
}

export interface SarvamStreamConfig {
  apiKey: string;
  url: string;
  model: string;
  streamType: string;
  mode: string;
  connectTimeoutMs: number;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });

/** WebSocket close code -> failure category (null = an ordinary close, not an error). */
function categoryForClose(code: number): ProviderFailureCategory | null {
  if (code === 1003) return "auth"; // rate limit, quota or invalid key: not a health signal, not worth retrying blindly
  if (code === 1008) return "timeout"; // inactivity
  if (code === 1011) return "server";
  if (code === 4000) return "invalid_request";
  if (code === 1000 || code === 1001 || code === 1005) return null;
  return "network";
}

type Status = "connecting" | "open" | "closing" | "closed";

export class SarvamSttStreamingSession implements SttStreamingSession {
  private status: Status = "connecting";
  private ready = false;
  private ws: WebSocket;
  private pending: string[] = [];
  private pendingBytes = 0;
  private readonly maxQueued: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenced = false;
  private closedEmitted = false;
  private closeWaiters: Array<() => void> = [];
  private readonly rate: number;
  private readonly onAbort = () => this.cancel();

  constructor(
    private readonly cfg: SarvamStreamConfig,
    private readonly handlers: SttStreamHandlers,
    private readonly opts: SttStreamOptions,
    socketFactory: SocketFactory = defaultSocketFactory,
  ) {
    this.maxQueued = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.rate = opts.sampleRate === 8000 ? 8000 : 16000;

    const lang = toRealtimeLanguage(opts.languageCode);
    if (lang.fellBack) {
      logger.warn("sarvam stt stream: language not supported by the realtime endpoint, using auto-detection", { callId: opts.callId });
    }
    const query = new URLSearchParams({
      language_code: lang.value,
      model: cfg.model,
      stream_type: cfg.streamType,
      mode: cfg.mode,
      endpointing: "manual",
      encoding: "linear16",
      sample_rate: String(this.rate),
    });
    this.ws = socketFactory(`${cfg.url}?${query.toString()}`, { "api-subscription-key": cfg.apiKey });

    this.connectTimer = setTimeout(() => this.fail("timeout", "timed out connecting"), cfg.connectTimeoutMs);
    this.connectTimer.unref?.();
    this.ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      this.fail(categoryForStatus(status), `connection refused (HTTP ${status})`, status);
    });
    this.ws.on("error", () => {
      // Details of a socket error may include addresses; report the category only. 'close' follows.
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

  sendAudio(pcm: Buffer): boolean {
    if (!this.open || pcm.length === 0) return this.open;
    const audio = this.rate === 16000 && this.opts.sampleRate !== 16000 ? resamplePcm16(pcm, this.opts.sampleRate, 16000) : pcm;
    for (let i = 0; i < audio.length; i += AUDIO_SLICE_BYTES) {
      const slice = audio.subarray(i, i + AUDIO_SLICE_BYTES);
      if (!this.send({ event: "audio_input", audio: slice.toString("base64") })) return false;
    }
    return true;
  }

  startUtterance(): boolean {
    return this.send({ event: "speech_start" });
  }

  endUtterance(): boolean {
    return this.send({ event: "speech_end" });
  }

  close(): Promise<void> {
    if (this.status === "closed") return Promise.resolve();
    const done = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    if (this.status === "closing") return done;
    if (this.send({ event: "end" })) {
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

  private send(message: Record<string, unknown>): boolean {
    if (this.status !== "connecting" && this.status !== "open") return false;
    const text = JSON.stringify(message);
    if (!this.ready) {
      if (this.pendingBytes + text.length > this.maxQueued) return this.fail("internal", "audio queue limit reached while connecting") && false;
      this.pending.push(text);
      this.pendingBytes += text.length;
      return true;
    }
    if (this.ws.bufferedAmount + text.length > this.maxQueued) return this.fail("internal", "socket congested: audio queue limit reached") && false;
    try {
      this.ws.send(text);
      return true;
    } catch {
      this.fail("network", "send failed");
      return false;
    }
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.status === "closed" || this.silenced) return;
    if (isBinary) return; // the realtime protocol is JSON text; ignore anything else
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.fail("bad_response", "provider sent a non-JSON message");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { event?: unknown }).event !== "string") {
      this.fail("bad_response", "provider sent a message without an event");
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.event) {
      case "session.begin":
        this.onReady();
        return;
      case "transcript.partial":
      case "transcript.final": {
        // Transcript events are what turns are built from: a malformed one makes alignment unknowable, so it fails the session.
        if (typeof m.text !== "string") {
          this.fail("bad_response", `malformed ${String(m.event)}`);
          return;
        }
        const event: SttTranscriptEvent = {
          text: m.text,
          utteranceIdx: typeof m.utterance_idx === "number" ? m.utterance_idx : undefined,
          languageCode: typeof m.language === "string" ? m.language : undefined,
        };
        this.deliver(() => (m.event === "transcript.final" ? this.handlers.onFinal(event) : this.handlers.onPartial(event)));
        return;
      }
      case "error": {
        if (m.is_fatal === true) {
          const status = typeof m.status_code === "number" ? m.status_code : undefined;
          this.fail(status ? categoryForStatus(status) : "server", "provider reported a fatal error", status);
        } else {
          logger.warn("sarvam stt stream: non-fatal provider error", { callId: this.opts.callId, code: typeof m.code === "string" ? m.code : undefined });
        }
        return;
      }
      case "session.end":
        this.teardown();
        return;
      default:
        return; // vad.*, config.updated, pong and anything newer: nothing to do under manual endpointing
    }
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
      for (const text of queued) this.ws.send(text);
    } catch {
      this.fail("network", "send failed");
      return;
    }
    this.pingTimer = setInterval(() => {
      if (this.status === "open") this.send({ event: "ping" });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private onSocketClose(code: number): void {
    if (this.status === "closed") return;
    if (this.status === "closing") return this.teardown();
    const category = categoryForClose(code);
    if (category) this.fail(category, `connection closed by provider (code ${code})`);
    else this.teardown();
  }

  private deliver(fn: () => void): void {
    if (this.status === "closed" || this.silenced) return;
    try {
      fn();
    } catch (err) {
      logger.error("sarvam stt stream: handler threw", { callId: this.opts.callId, errorName: err instanceof Error ? err.name : "UnknownError" });
    }
  }

  /** Reports ONE error, then tears the session down. Always returns true (so callers can `return this.fail(...) && false`). */
  private fail(category: ProviderFailureCategory, what: string, status?: number): true {
    if (this.status === "closed") return true;
    const error = new ProviderRequestError(PROVIDER, `${PROVIDER} ${OPERATION}: ${what}`, undefined, { category, operation: OPERATION, status });
    this.deliver(() => this.handlers.onError(error));
    this.teardown();
    return true;
  }

  private teardown(): void {
    if (this.status === "closed") return;
    this.status = "closed";
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pingTimer = this.connectTimer = null;
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
