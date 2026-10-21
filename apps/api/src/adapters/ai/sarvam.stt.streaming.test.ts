/**
 * Contract tests for the Sarvam realtime STT adapter: the REAL adapter against a local WebSocket server that speaks
 * Sarvam's documented realtime protocol (docs.sarvam.ai: speech-to-text-realtime/ws). No credentials or internet.
 * What these prove is that we follow the documented contract; they cannot prove Sarvam behaves as documented.
 */
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { SarvamSttStreamingSession, toRealtimeLanguage, type SarvamStreamConfig } from "./sarvam.stt.streaming.js";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import type { SttStreamHandlers, SttTranscriptEvent } from "./stt.interface.js";
import { ProviderConfigError, type ProviderRequestError } from "../../shared/errors.js";

interface Fake {
  url: string;
  received: Array<Record<string, unknown>>;
  requests: IncomingMessage[];
  sockets: ServerSocket[];
  /** Send a server message on the (first) connection. */
  send(msg: unknown): void;
  sendRaw(text: string): void;
  close(): Promise<void>;
}

const servers: Fake[] = [];

async function fakeSarvam(opts: { autoBegin?: boolean; verifyClient?: (req: IncomingMessage) => boolean | { status: number } } = {}): Promise<Fake> {
  const received: Fake["received"] = [];
  const requests: IncomingMessage[] = [];
  const sockets: ServerSocket[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: opts.verifyClient
      ? (info, cb) => {
          const r = opts.verifyClient!(info.req);
          if (r === true) cb(true);
          else cb(false, typeof r === "object" ? r.status : 401, "no");
        }
      : undefined,
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws, req) => {
    requests.push(req);
    sockets.push(ws);
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    if (opts.autoBegin !== false) ws.send(JSON.stringify({ event: "session.begin", request_id: "r1", config: {} }));
  });
  const fake: Fake = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/speech-to-text-realtime/ws`,
    received,
    requests,
    sockets,
    send: (m) => sockets[0].send(JSON.stringify(m)),
    sendRaw: (t) => sockets[0].send(t),
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.terminate());
        wss.close(() => r());
      }),
  };
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function harness() {
  const partials: SttTranscriptEvent[] = [];
  const finals: SttTranscriptEvent[] = [];
  const errors: ProviderRequestError[] = [];
  let closes = 0;
  const handlers: SttStreamHandlers = {
    onPartial: (e) => void partials.push(e),
    onFinal: (e) => void finals.push(e),
    onError: (e) => void errors.push(e as ProviderRequestError),
    onClose: () => void closes++,
  };
  return { partials, finals, errors, handlers, closes: () => closes };
}

const cfg = (url: string, over: Partial<SarvamStreamConfig> = {}): SarvamStreamConfig => ({
  apiKey: "test-key-123",
  url,
  model: "saaras:v3-realtime",
  streamType: "fast",
  mode: "transcribe",
  connectTimeoutMs: 2_000,
  ...over,
});

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const pcm = (n: number) => Buffer.alloc(n * 2, 1);

describe("language mapping (only documented realtime codes)", () => {
  it("maps agent languages to Sarvam's realtime language_code", () => {
    expect(toRealtimeLanguage(undefined)).toEqual({ value: "auto", fellBack: false });
    expect(toRealtimeLanguage("ta-IN")).toEqual({ value: "ta-IN", fellBack: false });
    expect(toRealtimeLanguage("en-IN")).toEqual({ value: "en-IN", fellBack: false });
    expect(toRealtimeLanguage("od-IN")).toEqual({ value: "or-IN", fellBack: false }); // batch says od-IN, realtime says or-IN
    expect(toRealtimeLanguage("xx-YY")).toEqual({ value: "auto", fellBack: true }); // never an invented code
  });
});

describe("connection and request shape", () => {
  it("connects with the documented URL parameters and auth header (key never in the URL)", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, languageCode: "ta-IN", callId: "c1" });
    await until(() => f.requests.length === 1);
    const url = new URL(f.requests[0].url!, "ws://x");
    expect(url.pathname).toBe("/speech-to-text-realtime/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      language_code: "ta-IN",
      model: "saaras:v3-realtime",
      stream_type: "fast",
      mode: "transcribe",
      endpointing: "manual",
      encoding: "linear16",
      sample_rate: "8000",
    });
    expect(f.requests[0].headers["api-subscription-key"]).toBe("test-key-123");
    expect(f.requests[0].url).not.toContain("test-key-123");
    s.cancel();
  });

  it("no language configured -> language_code=auto; 16 kHz stays 16 kHz", async () => {
    const f = await fakeSarvam();
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 16000 });
    await until(() => f.requests.length === 1);
    const q = new URL(f.requests[0].url!, "ws://x").searchParams;
    expect(q.get("language_code")).toBe("auto");
    expect(q.get("sample_rate")).toBe("16000");
    s.cancel();
  });

  it("the provider refuses to open a stream without SARVAM_API_KEY (a config error, nothing connects)", async () => {
    const prev = process.env.SARVAM_API_KEY;
    process.env.SARVAM_API_KEY = "";
    try {
      await expect(new SarvamSttProvider().startStreaming(harness().handlers, { sampleRate: 8000 })).rejects.toBeInstanceOf(ProviderConfigError);
    } finally {
      process.env.SARVAM_API_KEY = prev;
    }
  });

  it("the provider declares streaming capability and reads the realtime settings from configuration", async () => {
    const f = await fakeSarvam();
    const prev = { ...process.env };
    process.env.SARVAM_API_KEY = "k";
    process.env.SARVAM_STT_REALTIME_URL = f.url;
    process.env.SARVAM_STT_REALTIME_MODEL = "saaras:v4";
    process.env.SARVAM_STT_REALTIME_MODE = "codemix";
    try {
      const provider = new SarvamSttProvider();
      expect(provider.capabilities.streamingStt).toBe(true);
      const s = await provider.startStreaming(harness().handlers, { sampleRate: 8000, languageCode: "en-IN" });
      await until(() => f.requests.length === 1);
      const q = new URL(f.requests[0].url!, "ws://x").searchParams;
      expect(q.get("model")).toBe("saaras:v4");
      expect(q.get("mode")).toBe("codemix");
      s.cancel();
    } finally {
      for (const k of ["SARVAM_API_KEY", "SARVAM_STT_REALTIME_URL", "SARVAM_STT_REALTIME_MODEL", "SARVAM_STT_REALTIME_MODE"]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe("audio forwarding and manual endpointing", () => {
  it("sends speech_start, audio_input (base64 PCM) and speech_end in order", async () => {
    const f = await fakeSarvam();
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    const audio = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    expect(s.startUtterance()).toBe(true);
    expect(s.sendAudio(audio)).toBe(true);
    expect(s.endUtterance()).toBe(true);
    await until(() => f.received.length === 3);
    expect(f.received).toEqual([{ event: "speech_start" }, { event: "audio_input", audio: audio.toString("base64") }, { event: "speech_end" }]);
    s.cancel();
  });

  it("holds messages sent before session.begin and releases them in order once the provider accepts", async () => {
    const f = await fakeSarvam({ autoBegin: false });
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(100));
    await until(() => f.sockets.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.received).toEqual([]); // nothing before session.begin
    f.send({ event: "session.begin", request_id: "r" });
    await until(() => f.received.length === 2);
    expect(f.received.map((m) => m.event)).toEqual(["speech_start", "audio_input"]);
    s.cancel();
  });

  it("slices large buffers into 3,200-byte audio_input messages", async () => {
    const f = await fakeSarvam();
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    s.sendAudio(Buffer.alloc(8000, 1));
    await until(() => f.received.length === 3);
    const sizes = f.received.map((m) => Buffer.from(m.audio as string, "base64").length);
    expect(sizes).toEqual([3200, 3200, 1600]);
    s.cancel();
  });

  it("converts 24 kHz call audio to the 16 kHz the endpoint accepts, inside the adapter", async () => {
    const f = await fakeSarvam();
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 24000 });
    s.sendAudio(Buffer.alloc(2400 * 2, 1)); // 100 ms @ 24 kHz
    await until(() => f.received.length === 1);
    expect(Buffer.from(f.received[0].audio as string, "base64").length).toBe(1600 * 2); // 100 ms @ 16 kHz
    expect(new URL(f.requests[0].url!, "ws://x").searchParams.get("sample_rate")).toBe("16000");
    s.cancel();
  });

  it("keeps the connection alive with ping while idle", async () => {
    // The interval is 5 s; verify the message shape by invoking the documented keepalive through a short-lived fake timer.
    const f = await fakeSarvam();
    const s = new SarvamSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    await until(() => f.requests.length === 1);
    await until(() => f.received.some((m) => m.event === "ping"), 7_000);
    s.cancel();
  }, 10_000);
});

describe("transcript events", () => {
  it("delivers partials and finals separately, with language and the provider's utterance index", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.send({ event: "vad.speech_start", utterance_idx: 0, confidence: 0.9 });
    f.send({ event: "transcript.partial", utterance_idx: 0, text: "இந்த project", language: "ta-IN" });
    f.send({ event: "transcript.final", utterance_idx: 0, text: "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?", language: "ta-IN" });
    f.send({ event: "transcript.partial", utterance_idx: 1, text: "Can you tell" });
    f.send({ event: "transcript.final", utterance_idx: 1, text: "Can you tell me the price?" });
    await until(() => h.finals.length === 2);
    expect(h.partials.map((p) => p.text)).toEqual(["இந்த project", "Can you tell"]);
    expect(h.finals[0]).toEqual({ text: "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?", utteranceIdx: 0, languageCode: "ta-IN" });
    expect(h.finals[1]).toMatchObject({ text: "Can you tell me the price?", utteranceIdx: 1 });
    expect(h.errors).toEqual([]);
    s.cancel();
  });

  it("ignores events it does not need (vad.*, pong, config.updated, unknown, non-fatal errors) without failing", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    for (const m of [
      { event: "vad.speech_end", utterance_idx: 0 },
      { event: "pong" },
      { event: "config.updated", applied: [] },
      { event: "something.new", x: 1 },
      { event: "error", code: "invalid_config", is_fatal: false, message: "ignored" },
    ])
      f.send(m);
    f.send({ event: "transcript.final", utterance_idx: 0, text: "ok" });
    await until(() => h.finals.length === 1);
    expect(h.errors).toEqual([]);
    expect(s.open).toBe(true);
    s.cancel();
  });
});

describe("failures are reported once, as ProviderRequestError, without provider text or the key", () => {
  it("a malformed transcript event (no text) fails the session", async () => {
    const f = await fakeSarvam();
    const h = harness();
    new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.send({ event: "transcript.final", utterance_idx: 0, text: 42 });
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("bad_response");
    expect(h.finals).toEqual([]);
    await until(() => h.closes() === 1);
  });

  it("a non-JSON or event-less message fails the session", async () => {
    const f1 = await fakeSarvam();
    const h1 = harness();
    new SarvamSttStreamingSession(cfg(f1.url), h1.handlers, { sampleRate: 8000 });
    await until(() => f1.sockets.length === 1);
    f1.sendRaw("this is not json");
    await until(() => h1.errors.length === 1);
    expect(h1.errors[0].category).toBe("bad_response");

    const f2 = await fakeSarvam();
    const h2 = harness();
    new SarvamSttStreamingSession(cfg(f2.url), h2.handlers, { sampleRate: 8000 });
    await until(() => f2.sockets.length === 1);
    f2.send({ nothing: "here" });
    await until(() => h2.errors.length === 1);
  });

  it("a fatal provider error event fails the session, mapping status_code to a category", async () => {
    const f = await fakeSarvam();
    const h = harness();
    new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.send({ event: "error", code: "x", is_fatal: true, message: "secret transcript words", status_code: 429 });
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("rate_limited");
    expect(h.errors[0].message).not.toContain("secret transcript words");
    expect(JSON.stringify(h.errors[0].toLogFields())).not.toContain("test-key-123");
  });

  it.each([
    [1003, "auth"],
    [1008, "timeout"],
    [1011, "server"],
    [4000, "invalid_request"],
    [1006, "network"],
  ])("provider closing with code %i is a %s failure (a disconnect)", async (code, category) => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    if (code === 1006) f.sockets[0].terminate();
    else f.sockets[0].close(code, "bye");
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe(category);
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);
  });

  it("a normal close (1000) is not an error", async () => {
    const f = await fakeSarvam();
    const h = harness();
    new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.sockets[0].close(1000);
    await until(() => h.closes() === 1);
    expect(h.errors).toEqual([]);
  });

  it("a refused handshake is classified from the HTTP status (401 -> auth)", async () => {
    const f = await fakeSarvam({ verifyClient: () => ({ status: 401 }) });
    const h = harness();
    new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("auth");
    expect(h.errors[0].status).toBe(401);
  });

  it("an unreachable server is a network failure; a silent one is a connect timeout", async () => {
    const h1 = harness();
    new SarvamSttStreamingSession(cfg("ws://127.0.0.1:1/x"), h1.handlers, { sampleRate: 8000 });
    await until(() => h1.errors.length === 1);
    expect(h1.errors[0].category).toBe("network");

    const f = await fakeSarvam({ autoBegin: false });
    const h2 = harness();
    new SarvamSttStreamingSession(cfg(f.url, { connectTimeoutMs: 150 }), h2.handlers, { sampleRate: 8000 });
    await until(() => h2.errors.length === 1);
    expect(h2.errors[0].category).toBe("timeout");
  });

  it("bounded queue: audio held while connecting beyond the cap fails the session instead of growing", async () => {
    const f = await fakeSarvam({ autoBegin: false });
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, maxQueuedBytes: 2_000 });
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) refused = !s.sendAudio(pcm(800));
    expect(refused).toBe(true);
    expect(h.errors.length).toBe(1);
    expect(s.open).toBe(false);
    expect(s.sendAudio(pcm(10))).toBe(false);
  });

  it("a throwing handler does not break the session", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(
      cfg(f.url),
      {
        ...h.handlers,
        onPartial: () => {
          throw new Error("handler bug");
        },
      },
      { sampleRate: 8000 },
    );
    await until(() => f.sockets.length === 1);
    f.send({ event: "transcript.partial", utterance_idx: 0, text: "a" });
    f.send({ event: "transcript.final", utterance_idx: 0, text: "b" });
    await until(() => h.finals.length === 1);
    s.cancel();
  });
});

describe("cancellation and cleanup", () => {
  it("cancel() drops the connection at once, emits onClose exactly once and no transcripts afterwards", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    s.cancel();
    s.cancel();
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);
    expect(s.sendAudio(pcm(10))).toBe(false);
    expect(s.startUtterance()).toBe(false);
    await until(() => f.sockets[0].readyState === 3);
    expect(h.errors).toEqual([]);
    expect(h.finals).toEqual([]);
  });

  it("aborting the signal cancels the session (also if already aborted)", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const ac = new AbortController();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, signal: ac.signal });
    await until(() => f.sockets.length === 1);
    ac.abort();
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);
    expect(h.errors).toEqual([]);

    const h2 = harness();
    const s2 = new SarvamSttStreamingSession(cfg(f.url), h2.handlers, { sampleRate: 8000, signal: AbortSignal.abort() });
    await until(() => h2.closes() === 1);
    expect(s2.open).toBe(false);
  });

  it("close() is graceful: sends `end`, waits for session.end, then releases", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    const closing = s.close();
    await until(() => f.received.some((m) => m.event === "end"));
    f.send({ event: "session.end", request_id: "r", total_duration_s: 1, total_utterances: 0, audio_duration_s: 0 });
    await closing;
    expect(h.closes()).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("close() still releases if the provider never answers `end`", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    await s.close(); // gives up after its grace period
    expect(h.closes()).toBe(1);
  }, 10_000);

  it("many sessions at once stay independent", async () => {
    const f = await fakeSarvam();
    const hs = Array.from({ length: 12 }, () => harness());
    const sessions = hs.map((h) => new SarvamSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 }));
    await until(() => f.sockets.length === 12);
    // Each connection answers only itself.
    f.sockets.forEach((sock, i) => sock.send(JSON.stringify({ event: "transcript.final", utterance_idx: 0, text: `session-${i}` })));
    await until(() => hs.every((h) => h.finals.length === 1));
    const texts = hs.map((h) => h.finals[0].text).sort();
    expect(new Set(texts).size).toBe(12);
    sessions[0].cancel();
    expect(sessions[1].open).toBe(true);
    sessions.forEach((s) => s.cancel());
    expect(hs.every((h) => h.closes() === 1)).toBe(true);
  });
});
