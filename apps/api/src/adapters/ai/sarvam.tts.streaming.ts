/**
 * Sarvam streaming TTS session. ALL Sarvam TTS-WebSocket protocol details live in this file.
 *
 * Contract used (Sarvam docs: api-reference-docs/text-to-speech/stream and the "Streaming TTS" WebSocket guide):
 *
 *   URL      wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true   (config: SARVAM_TTS_STREAM_URL)
 *   Auth     header  api-subscription-key: <key>                    (never in the URL, never logged)
 *   Client   {"type":"config","data":{language_code, speaker, model, speech_sample_rate, output_audio_codec, ...}}  FIRST
 *            {"type":"text","data":{"text":"..."}}   1-2500 characters
 *            {"type":"flush"}                        synthesize what is buffered now (otherwise it waits for min_buffer_size)
 *   Server   {"type":"audio","data":{content_type, audio:"<base64>", request_id}}
 *            {"type":"event","data":{"event_type":"final", ...}}   "when speech generation ends" (we send ONE flush per text)
 *            {"type":"error","data":{message, code, details, request_id}}
 *
 * Design choices that follow from it:
 *  - One text + one flush per sentence; each `final` event completes the oldest outstanding segment (events are assumed
 *    to arrive in flush order, on one connection).
 *  - We ask for `linear16` at the call's rate. The docs do not say whether those chunks carry a WAV header, so each chunk
 *    is inspected: "RIFF" -> header stripped (and resampled if the rate differs); otherwise raw PCM at the requested rate.
 *  - Realtime retry is NOT replay: a failed session fails. The caller decides what to do (it knows whether audio was heard).
 *  - Memory is bounded: text sent while connecting is capped; audio is passed straight to the handler.
 *  - Provider message text is never copied into our errors or logs (it can echo the text being spoken).
 */
import WebSocket from "ws";
import type { TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions } from "./tts.interface.js";
import { ProviderRequestError, type ProviderFailureCategory } from "../../shared/errors.js";
import { categoryForStatus } from "./provider-errors.js";
import { parseWav, resamplePcm16 } from "../../audio/pcm.js";
import { logger } from "../../shared/logger.js";
import type { SocketFactory } from "./sarvam.stt.streaming.js";

const PROVIDER = "sarvam";
const OPERATION = "tts.stream";
const MAX_TEXT_CHARS = 2500; // documented per-message limit
const MAX_PENDING_CHARS = 16_000; // text held while the connection is opening
const GRACEFUL_CLOSE_WAIT_MS = 5_000;

export interface SarvamTtsStreamConfig {
  apiKey: string;
  url: string;
  model: string;
  /** Used when the agent has no voice configured. */
  defaultSpeaker: string;
  connectTimeoutMs: number;
}

const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 });

/** WebSocket close code -> failure category (null = an ordinary close). */
function categoryForClose(code: number): ProviderFailureCategory | null {
  if (code === 1000 || code === 1001 || code === 1005) return null;
  if (code === 1011) return "server";
  if (code >= 4000 && code < 5000) return "auth"; // documented: 4xxx = auth / quota; fix the cause, do not retry blindly
  return "network";
}

type Status = "connecting" | "open" | "closing" | "closed";

export class SarvamTtsStreamingSession implements TtsStreamingSession {
  private status: Status = "connecting";
  private ready = false;
  private readonly ws: WebSocket;
  private pending: string[] = [];
  private pendingChars = 0;
  private outstanding = 0;
  private carry: Buffer = Buffer.alloc(0); // an odd trailing byte of raw PCM, completed by the next chunk
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private silenced = false;
  private closedEmitted = false;
  private closeWaiters: Array<() => void> = [];
  private readonly onAbort = () => this.cancel();

  constructor(
    private readonly cfg: SarvamTtsStreamConfig,
    private readonly handlers: TtsStreamHandlers,
    private readonly opts: TtsStreamOptions,
    socketFactory: SocketFactory = defaultSocketFactory,
  ) {
    const query = new URLSearchParams({ model: cfg.model, send_completion_event: "true" });
    this.ws = socketFactory(`${cfg.url}?${query.toString()}`, { "api-subscription-key": cfg.apiKey });

    this.connectTimer = setTimeout(() => this.fail("timeout", "timed out connecting"), cfg.connectTimeoutMs);
    this.connectTimer.unref?.();
    this.ws.on("open", () => this.onOpen());
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

  sendText(text: string): boolean {
    if (!this.open) return false;
    const clean = text.trim();
    if (!clean) return true;
    const parts: string[] = [];
    for (let i = 0; i < clean.length; i += MAX_TEXT_CHARS) parts.push(clean.slice(i, i + MAX_TEXT_CHARS));
    const messages = parts.map((p) => JSON.stringify({ type: "text", data: { text: p } }));
    messages.push(JSON.stringify({ type: "flush" }));
    this.outstanding++;
    for (const m of messages) if (!this.send(m)) return false;
    return true;
  }

  close(): Promise<void> {
    if (this.status === "closed") return Promise.resolve();
    const done = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    if (this.outstanding === 0) {
      this.teardown();
    } else if (this.status !== "closing") {
      this.status = "closing"; // finish what was sent, then end
      this.closeTimer = setTimeout(() => this.teardown(), GRACEFUL_CLOSE_WAIT_MS);
      this.closeTimer.unref?.();
    }
    return done;
  }

  cancel(): void {
    this.silenced = true;
    this.teardown();
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private send(message: string): boolean {
    if (!this.ready) {
      if (this.pendingChars + message.length > MAX_PENDING_CHARS) return this.fail("internal", "text queue limit reached while connecting") && false;
      this.pending.push(message);
      this.pendingChars += message.length;
      return true;
    }
    try {
      this.ws.send(message);
      return true;
    } catch {
      this.fail("network", "send failed");
      return false;
    }
  }

  private onOpen(): void {
    if (this.ready || this.status === "closed") return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.ready = true;
    if (this.status === "connecting") this.status = "open";
    // The config message MUST be first.
    const config = {
      type: "config",
      data: {
        language_code: this.opts.languageCode ?? "en-IN",
        speaker: this.opts.voice ?? this.cfg.defaultSpeaker,
        model: this.cfg.model,
        speech_sample_rate: this.opts.sampleRate,
        output_audio_codec: "linear16",
      },
    };
    const queued = this.pending;
    this.pending = [];
    this.pendingChars = 0;
    try {
      this.ws.send(JSON.stringify(config));
      for (const m of queued) this.ws.send(m);
    } catch {
      this.fail("network", "send failed");
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
    const m = (msg ?? {}) as { type?: unknown; data?: Record<string, unknown> };
    switch (m.type) {
      case "audio": {
        const b64 = m.data?.audio;
        if (typeof b64 !== "string" || b64.length === 0) {
          this.fail("bad_response", "malformed audio message");
          return;
        }
        let pcm: Buffer;
        try {
          pcm = this.toPcm(Buffer.from(b64, "base64"));
        } catch {
          this.fail("bad_response", "unusable audio chunk");
          return;
        }
        if (pcm.length > 0) this.deliver(() => this.handlers.onAudio(pcm));
        return;
      }
      case "event": {
        if (m.data?.event_type !== "final") return;
        if (this.outstanding === 0) return; // not ours to count (e.g. a stray event)
        this.outstanding--;
        this.deliver(() => this.handlers.onSegmentComplete());
        if (this.status === "closing" && this.outstanding === 0) this.teardown();
        return;
      }
      case "error": {
        const code = typeof m.data?.code === "number" ? m.data.code : undefined;
        const category = code && code >= 400 && code < 600 ? categoryForStatus(code) : "server";
        this.fail(category, "provider reported an error", code);
        return;
      }
      default:
        return; // unknown / newer message types are ignored
    }
  }

  /** A chunk as the provider sent it -> raw PCM at the requested rate. */
  private toPcm(bytes: Buffer): Buffer {
    let pcm: Buffer;
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF") {
      const wav = parseWav(bytes);
      if (!wav) throw new Error("bad wav");
      pcm = resamplePcm16(wav.pcm, wav.sampleRate, this.opts.sampleRate);
    } else {
      pcm = bytes;
    }
    if (this.carry.length > 0) {
      pcm = Buffer.concat([this.carry, pcm]);
      this.carry = Buffer.alloc(0);
    }
    if (pcm.length % 2 !== 0) {
      this.carry = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    return pcm;
  }

  private onSocketClose(code: number): void {
    if (this.status === "closed") return;
    const category = categoryForClose(code);
    // A provider-side close with nothing outstanding (e.g. its inactivity close) loses nothing.
    if (category && this.outstanding > 0) this.fail(category, `connection closed by provider (code ${code})`);
    else this.teardown();
  }

  private deliver(fn: () => void): void {
    if (this.status === "closed" || this.silenced) return;
    try {
      fn();
    } catch (err) {
      logger.error("sarvam tts stream: handler threw", { callId: this.opts.callId, errorName: err instanceof Error ? err.name : "UnknownError" });
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
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.connectTimer = this.closeTimer = null;
    this.pending = [];
    this.pendingChars = 0;
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
