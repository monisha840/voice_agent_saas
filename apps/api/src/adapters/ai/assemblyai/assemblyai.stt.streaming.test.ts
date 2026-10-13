/**
 * EXPERIMENT — contract tests for the AssemblyAI streaming adapter: the REAL adapter against a local WebSocket server
 * that speaks AssemblyAI's documented v3 streaming protocol. No credentials or internet. They prove we follow the
 * documented contract; they cannot prove the live service behaves as documented (see ASSEMBLYAI_EXPERIMENT.md).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { AssemblyAiSttStreamingSession, type AssemblyAiStreamConfig } from "./assemblyai.stt.streaming.js";
import { AssemblyAiSttProvider, assemblyAiSupportsLanguage } from "./assemblyai.stt.provider.js";
import { createAssemblyAiStt } from "./index.js";
import { getSttProvider, setSttProvider } from "../index.js";
import { ReliableSpeechToText } from "../reliable-providers.js";
import type { SttStreamHandlers, SttTranscriptEvent } from "../stt.interface.js";
import { ProviderConfigError, type ProviderRequestError } from "../../../shared/errors.js";
import { SttStreamCoordinator } from "../../../realtime/stt-stream.js";
import { TurnController } from "../../../realtime/turn-controller.js";
import { TurnDetector } from "../../../audio/turn-detector.js";

interface Fake {
  url: string;
  requests: IncomingMessage[];
  sockets: ServerSocket[];
  /** Everything the client sent, in order: "audio:<bytes>" for binary frames, otherwise the JSON message. */
  order: Array<string | Record<string, unknown>>;
  audio: Buffer[];
  send(msg: unknown): void;
  sendRaw(text: string): void;
  close(): Promise<void>;
}
const servers: Fake[] = [];

async function fakeAai(
  opts: { begin?: boolean | Record<string, unknown>; verify?: (req: IncomingMessage) => boolean | { status: number }; onClient?: (msg: Record<string, unknown>, ws: ServerSocket) => void } = {},
): Promise<Fake> {
  const requests: IncomingMessage[] = [];
  const sockets: ServerSocket[] = [];
  const order: Fake["order"] = [];
  const audio: Buffer[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: opts.verify
      ? (info, cb) => {
          const r = opts.verify!(info.req);
          if (r === true) cb(true);
          else cb(false, typeof r === "object" ? r.status : 401, "no");
        }
      : undefined,
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws, req) => {
    requests.push(req);
    sockets.push(ws);
    ws.on("message", (d, isBinary) => {
      if (isBinary) {
        const b = Buffer.from(d as Buffer);
        audio.push(b);
        order.push(`audio:${b.length}`);
        return;
      }
      const m = JSON.parse(d.toString());
      order.push(m);
      opts.onClient?.(m, ws);
    });
    if (opts.begin !== false) {
      const model = new URL(req.url!, "ws://x").searchParams.get("speech_model");
      ws.send(JSON.stringify({ type: "Begin", id: "sess-1", expires_at: 1772570132, configuration: { model, ...(typeof opts.begin === "object" ? opts.begin : {}) } }));
    }
  });
  const fake: Fake = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v3/ws`,
    requests,
    sockets,
    order,
    audio,
    send: (m) => sockets[0].send(JSON.stringify(m)),
    sendRaw: (t) => sockets[0].send(t),
    close: () => new Promise((r) => (sockets.forEach((s) => s.terminate()), wss.close(() => r()))),
  };
  servers.push(fake);
  return fake;
}

const turn = (over: Record<string, unknown>) => ({
  type: "Turn",
  turn_order: 0,
  turn_is_formatted: true,
  end_of_turn: true,
  transcript: "",
  utterance: "",
  end_of_turn_confidence: 1,
  words: [],
  ...over,
});
const partial = (text: string, order = 0) => turn({ end_of_turn: false, turn_is_formatted: false, transcript: text, turn_order: order });
const final = (text: string, order = 0) => turn({ transcript: text, utterance: text, turn_order: order });

const ENV = ["ASSEMBLYAI_API_KEY", "ASSEMBLYAI_STT_URL", "ASSEMBLYAI_STT_MODEL", "ASSEMBLYAI_STT_FLUSH_GRACE_MS", "REALTIME_STT_PROVIDER", "REALTIME_STT_STREAMING", "AI_PROVIDER"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
});
afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setSttProvider(null);
  for (const s of servers.splice(0)) await s.close();
});

const KEY = "aai-test-key-4242";
const cfg = (url: string, over: Partial<AssemblyAiStreamConfig> = {}): AssemblyAiStreamConfig => ({
  apiKey: KEY,
  url,
  model: "universal-streaming-english",
  minTurnSilenceMs: 5000,
  maxTurnSilenceMs: 8000,
  flushGraceMs: 150,
  connectTimeoutMs: 2000,
  ...over,
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await wait(8);
  }
};
const pcm = (ms: number, rate = 8000, fill = 3) => Buffer.alloc(Math.round((rate * 2 * ms) / 1000), fill);
/** A session wired to a fake that answers ForceEndpoint with the given scripted final. */
const forceAnswer = (text: string, order = 0) => (m: Record<string, unknown>, ws: ServerSocket) => {
  if (m.type === "ForceEndpoint") ws.send(JSON.stringify(final(text, order)));
};

describe("initialization and configuration", () => {
  it("is an experimental, streaming-only provider behind the normal ISpeechToText interface", async () => {
    const p = new AssemblyAiSttProvider();
    expect(p.name).toBe("assemblyai-stt");
    expect(p.capabilities.streamingStt).toBe(true);
    await expect(p.transcribe(Buffer.alloc(10))).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("refuses to open a stream without ASSEMBLYAI_API_KEY (a config error; nothing connects)", async () => {
    process.env.ASSEMBLYAI_API_KEY = "";
    await expect(new AssemblyAiSttProvider().startStreaming(harness().handlers, { sampleRate: 8000 })).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it.each([
    ["universal-streaming-english", "en-IN", true],
    ["universal-streaming-english", "en", true],
    ["universal-streaming-english", undefined, true],
    ["universal-streaming-english", "ta-IN", false],
    ["universal-streaming-english", "hi-IN", false],
    ["universal-3-6-pro", "hi-IN", true],
    ["universal-3-6-pro", "ta-IN", false],
    ["universal-3-6-pro", "en-IN", true],
  ])("model %s, language %s -> supported=%s (Tamil is never claimed)", (model, lang, ok) => {
    expect(assemblyAiSupportsLanguage(model, lang)).toBe(ok);
  });

  it("an unsupported language is refused up front with a clear error, not transcribed wrongly", async () => {
    process.env.ASSEMBLYAI_API_KEY = KEY;
    const err = await new AssemblyAiSttProvider().startStreaming(harness().handlers, { sampleRate: 8000, languageCode: "ta-IN" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderConfigError);
    expect(err.message).toMatch(/does not support language "ta-IN"/);
    expect(err.message).not.toContain(KEY);
  });

  it("Sarvam stays the default: nothing selects AssemblyAI unless REALTIME_STT_PROVIDER=assemblyai", () => {
    delete process.env.REALTIME_STT_PROVIDER;
    process.env.ASSEMBLYAI_API_KEY = KEY; // a key being present is not a selection
    process.env.AI_PROVIDER = "mock";
    setSttProvider(null);
    expect(getSttProvider().name).toBe("mock-stt");
    process.env.AI_PROVIDER = "sarvam";
    setSttProvider(null);
    expect(getSttProvider().name).toBe("sarvam-saaras");
  });

  it("explicit selection yields the AssemblyAI provider, wrapped in the normal reliability layer", () => {
    process.env.REALTIME_STT_PROVIDER = "assemblyai";
    process.env.REALTIME_STT_STREAMING = "true";
    process.env.ASSEMBLYAI_API_KEY = KEY;
    setSttProvider(null);
    const p = getSttProvider();
    expect(p).toBeInstanceOf(ReliableSpeechToText);
    expect(p.name).toBe("assemblyai-stt");
    expect(typeof p.startStreaming).toBe("function");
  });

  it("selected but unconfigured FAILS (no key, or streaming off); it never silently becomes another provider", () => {
    process.env.REALTIME_STT_PROVIDER = "assemblyai";
    process.env.REALTIME_STT_STREAMING = "true";
    process.env.ASSEMBLYAI_API_KEY = "";
    setSttProvider(null);
    expect(() => getSttProvider()).toThrow(/ASSEMBLYAI_API_KEY/);
    process.env.ASSEMBLYAI_API_KEY = KEY;
    process.env.REALTIME_STT_STREAMING = "false";
    expect(() => createAssemblyAiStt()).toThrow(/REALTIME_STT_STREAMING/);
  });

  it("an invalid REALTIME_STT_PROVIDER value is rejected rather than guessed", () => {
    process.env.REALTIME_STT_PROVIDER = "deepgram";
    setSttProvider(null);
    expect(() => getSttProvider()).toThrow(/Invalid provider value/);
  });
});

describe("authentication and connection", () => {
  it("connects with the documented URL parameters and the raw key in the Authorization header", async () => {
    const f = await fakeAai();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000, callId: "c1" });
    await until(() => f.requests.length === 1);
    const url = new URL(f.requests[0].url!, "ws://x");
    expect(url.pathname).toBe("/v3/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      speech_model: "universal-streaming-english",
      encoding: "pcm_s16le",
      sample_rate: "8000", // telephony audio goes out at its own rate: no resampling
      format_turns: "true",
      min_turn_silence: "5000",
      max_turn_silence: "8000",
    });
    expect(f.requests[0].headers.authorization).toBe(KEY); // no "Bearer"
    expect(f.requests[0].url).not.toContain(KEY);
    s.cancel();
  });

  it("the provider takes URL, model and silence settings from configuration", async () => {
    const f = await fakeAai();
    process.env.ASSEMBLYAI_API_KEY = KEY;
    process.env.ASSEMBLYAI_STT_URL = f.url;
    process.env.ASSEMBLYAI_STT_MODEL = "universal-3-6-pro";
    const s = await new AssemblyAiSttProvider().startStreaming(harness().handlers, { sampleRate: 16000, languageCode: "en-IN" });
    await until(() => f.requests.length === 1);
    const q = new URL(f.requests[0].url!, "ws://x").searchParams;
    expect(q.get("speech_model")).toBe("universal-3-6-pro");
    expect(q.get("sample_rate")).toBe("16000");
    s.cancel();
  });

  it("holds audio until Begin, then releases it in order", async () => {
    const f = await fakeAai({ begin: false });
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(100));
    await until(() => f.sockets.length === 1);
    await wait(50);
    expect(f.order).toEqual([]);
    f.send({ type: "Begin", id: "x", configuration: { model: "universal-streaming-english" } });
    await until(() => f.order.length === 1);
    expect(f.order).toEqual(["audio:1600"]);
    s.cancel();
  });

  it("a refused handshake is classified from the HTTP status (401 -> auth)", async () => {
    const f = await fakeAai({ verify: () => ({ status: 401 }) });
    const h = harness();
    new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("auth");
    expect(h.errors[0].status).toBe(401);
    expect(h.errors[0].message).not.toContain(KEY);
  });

  it("an unreachable server is a network failure; no Begin in time is a connect timeout", async () => {
    const h1 = harness();
    new AssemblyAiSttStreamingSession(cfg("ws://127.0.0.1:1/v3/ws"), h1.handlers, { sampleRate: 8000 });
    await until(() => h1.errors.length === 1);
    expect(h1.errors[0].category).toBe("network");

    const f = await fakeAai({ begin: false });
    const h2 = harness();
    new AssemblyAiSttStreamingSession(cfg(f.url, { connectTimeoutMs: 150 }), h2.handlers, { sampleRate: 8000 });
    await until(() => h2.errors.length === 1);
    expect(h2.errors[0].category).toBe("timeout");
  });

  it("Begin reporting a different model than requested fails (the service ignores unknown parameters)", async () => {
    const f = await fakeAai({ begin: { model: "some-other-model" } });
    const h = harness();
    new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("invalid_request");
  });
});

describe("audio framing (50-1000 ms, raw PCM, no conversion)", () => {
  it("sends a 100 ms frame as one binary frame with exactly the same bytes (8 kHz stays 8 kHz)", async () => {
    const f = await fakeAai();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    const frame = Buffer.from(Array.from({ length: 1600 }, (_, i) => i % 251));
    s.sendAudio(frame);
    await until(() => f.audio.length === 1);
    expect(f.audio[0].equals(frame)).toBe(true);
    s.cancel();
  });

  it("joins fragments shorter than 50 ms and splits runs longer than 1000 ms", async () => {
    const f = await fakeAai();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    for (let i = 0; i < 4; i++) s.sendAudio(pcm(20)); // 320 bytes each: 20 ms
    await until(() => f.audio.length >= 1);
    expect(f.audio.map((b) => b.length)).toEqual([960]); // 3 x 20 ms = 60 ms sent once it reached 50 ms; the 4th is held
    s.sendAudio(pcm(2500)); // 40,000 bytes + 320 held
    await until(() => f.audio.length >= 3);
    for (const b of f.audio) {
      expect(b.length).toBeGreaterThanOrEqual(800); // >= 50 ms
      expect(b.length).toBeLessThanOrEqual(16000); // <= 1000 ms
    }
    s.cancel();
  });

  it("the tail of an utterance is padded with silence up to 50 ms, then ForceEndpoint follows the audio", async () => {
    const f = await fakeAai();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(20)); // held: 20 ms
    s.endUtterance();
    await until(() => f.order.length === 2);
    expect(f.order).toEqual(["audio:800", { type: "ForceEndpoint" }]);
    expect(f.audio[0].subarray(0, 320).every((b) => b === 3)).toBe(true);
    expect(f.audio[0].subarray(320).every((b) => b === 0)).toBe(true);
    s.cancel();
  });

  it("respects the call's rate for the frame limits (16 kHz: 50 ms = 1,600 bytes)", async () => {
    const f = await fakeAai();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 16000 });
    s.sendAudio(pcm(30, 16000));
    s.sendAudio(pcm(30, 16000));
    await until(() => f.audio.length === 1);
    expect(f.audio[0].length).toBe(1920);
    expect(new URL(f.requests[0].url!, "ws://x").searchParams.get("sample_rate")).toBe("16000");
    s.cancel();
  });
});

describe("transcript mapping", () => {
  it("cumulative partials become onPartial; empty partials and non-final messages are never finals", async () => {
    const f = await fakeAai();
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    await until(() => f.sockets.length === 1);
    f.send({ type: "SpeechStarted", timestamp: 1200, confidence: 0.99 });
    f.send(partial(""));
    f.send(partial("hello i am"));
    f.send(partial("hello i am looking for"));
    await until(() => h.partials.length === 2);
    expect(h.partials.map((p) => p.text)).toEqual(["hello i am", "hello i am looking for"]);
    expect(h.finals).toEqual([]);
    s.cancel();
  });

  it("ForceEndpoint yields exactly one final with the (trimmed) formatted transcript", async () => {
    const f = await fakeAai({ onClient: forceAnswer("  Hello, I am looking for a two bedroom apartment.  ") });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(100));
    s.endUtterance();
    await until(() => h.finals.length === 1);
    expect(h.finals[0].text).toBe("Hello, I am looking for a two bedroom apartment.");
    await wait(60);
    expect(h.finals.length).toBe(1);
    s.cancel();
  });

  it("an unformatted final is followed by the formatted one for the same turn: only ONE final results", async () => {
    const f = await fakeAai({
      onClient: (m, ws) => {
        if (m.type !== "ForceEndpoint") return;
        ws.send(JSON.stringify(turn({ turn_is_formatted: false, transcript: "can you tell me the price", turn_order: 4 })));
        ws.send(JSON.stringify(turn({ turn_is_formatted: true, transcript: "Can you tell me the price?", turn_order: 4 })));
        ws.send(JSON.stringify(turn({ turn_is_formatted: true, transcript: "Can you tell me the price?", turn_order: 4 }))); // and a repeat
      },
    });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.endUtterance();
    await until(() => h.finals.length === 1);
    await wait(80);
    expect(h.finals.map((x) => x.text)).toEqual(["Can you tell me the price?"]);
    s.cancel();
  });

  it("a turn the service ended by itself mid-utterance is held and joined to the ForceEndpoint answer (one final per utterance)", async () => {
    const f = await fakeAai({ onClient: forceAnswer("and the location", 1) });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(100));
    await until(() => f.sockets.length === 1);
    f.send(final("What is the price", 0)); // provider endpointed on its own during a pause
    await wait(50);
    expect(h.finals).toEqual([]); // not surfaced yet: the application's utterance has not ended
    s.endUtterance();
    await until(() => h.finals.length === 1);
    expect(h.finals[0].text).toBe("What is the price and the location");
    s.cancel();
  });

  it("if ForceEndpoint gets no answer, what was held is settled after the grace period (never hangs)", async () => {
    const f = await fakeAai(); // never answers ForceEndpoint
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url, { flushGraceMs: 120 }), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    await until(() => f.sockets.length === 1);
    f.send(final("Early final text", 0));
    s.endUtterance();
    await until(() => h.finals.length === 1);
    expect(h.finals[0].text).toBe("Early final text");

    s.startUtterance();
    s.endUtterance();
    await until(() => h.finals.length === 2);
    expect(h.finals[1].text).toBe(""); // nothing was said: an empty final, not a hang
    s.cancel();
  });

  it("utterances that overlap (the next starts before the previous final arrives) are answered in order", async () => {
    const f = await fakeAai();
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url, { flushGraceMs: 5000 }), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.endUtterance();
    s.startUtterance();
    s.endUtterance();
    await until(() => f.order.filter((o) => typeof o !== "string").length === 2);
    f.send(final("first answer", 0));
    f.send(final("second answer", 1));
    await until(() => h.finals.length === 2);
    expect(h.finals.map((x) => x.text)).toEqual(["first answer", "second answer"]);
    s.cancel();
  });

  it("a final with no utterance in progress is ignored", async () => {
    const f = await fakeAai();
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.send(final("stray", 0));
    await wait(60);
    expect(h.finals).toEqual([]);
    expect(h.errors).toEqual([]);
    s.cancel();
  });

  it("ignores messages it does not need (SpeechStarted, Heartbeat, SpeakerRevision, unknown types)", async () => {
    const f = await fakeAai({ onClient: forceAnswer("ok") });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    for (const m of [{ type: "SpeechStarted", timestamp: 1, confidence: 1 }, { type: "Heartbeat" }, { type: "SpeakerRevision", revisions: [] }, { type: "Brand.New" }]) f.send(m);
    s.startUtterance();
    s.endUtterance();
    await until(() => h.finals.length === 1);
    expect(h.errors).toEqual([]);
    s.cancel();
  });
});

describe("failures are reported once, as ProviderRequestError, without provider text or the key", () => {
  it.each([
    ["non-JSON message", "this is not json", "bad_response"],
    ["message without a type", JSON.stringify({ hello: 1 }), "bad_response"],
    ["Turn without a transcript", JSON.stringify({ type: "Turn", end_of_turn: true }), "bad_response"],
    ["Error 3007 (audio sent too fast)", JSON.stringify({ type: "Error", error_code: 3007, error: "SECRET words" }), "internal"],
    ["Error 3006 (inactivity)", JSON.stringify({ type: "Error", error_code: 3006, error: "SECRET words" }), "timeout"],
    ["Error 3008 (session expired)", JSON.stringify({ type: "Error", error_code: 3008, error: "SECRET words" }), "timeout"],
    ["Error 1008 (new-session rate limit)", JSON.stringify({ type: "Error", error_code: 1008, error: "SECRET words" }), "rate_limited"],
    ["Error with an undocumented code", JSON.stringify({ type: "Error", error_code: 9999, error: "SECRET words" }), "server"],
  ])("%s", async (_n, raw, category) => {
    const f = await fakeAai();
    const h = harness();
    new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.sendRaw(raw);
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe(category);
    expect(h.errors[0].message).not.toContain("SECRET");
    expect(JSON.stringify(h.errors[0].toLogFields())).not.toContain(KEY);
    await until(() => h.closes() === 1);
    expect(h.errors.length).toBe(1);
  });

  it("an abnormal close is a network failure (a disconnect); a normal close is not an error", async () => {
    const f = await fakeAai();
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    f.sockets[0].close(1011, "boom");
    await until(() => h.errors.length === 1);
    expect(h.errors[0].category).toBe("network");
    expect(s.open).toBe(false);

    const f2 = await fakeAai();
    const h2 = harness();
    new AssemblyAiSttStreamingSession(cfg(f2.url), h2.handlers, { sampleRate: 8000 });
    await until(() => f2.sockets.length === 1);
    f2.sockets[0].close(1000);
    await until(() => h2.closes() === 1);
    expect(h2.errors).toEqual([]);
  });

  it("bounded queue: audio held while connecting beyond the cap fails the session instead of growing", async () => {
    const f = await fakeAai({ begin: false });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, maxQueuedBytes: 4000 });
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) refused = !s.sendAudio(pcm(100));
    expect(refused).toBe(true);
    expect(h.errors.length).toBe(1);
    expect(s.sendAudio(pcm(100))).toBe(false);
  });

  it("a throwing handler does not break the session", async () => {
    const f = await fakeAai({ onClient: forceAnswer("fine") });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(
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
    f.send(partial("x"));
    s.startUtterance();
    s.endUtterance();
    await until(() => h.finals.length === 1);
    s.cancel();
  });
});

describe("cancellation and cleanup", () => {
  it("cancel() stops at once: onClose exactly once, nothing sent or delivered afterwards, late finals dropped", async () => {
    const f = await fakeAai({ onClient: (m, ws) => m.type === "ForceEndpoint" && setTimeout(() => ws.send(JSON.stringify(final("late", 0))), 60) });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(pcm(100));
    s.endUtterance();
    await until(() => f.order.some((o) => typeof o !== "string"));
    s.cancel();
    s.cancel();
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);
    expect(s.sendAudio(pcm(100))).toBe(false);
    expect(s.startUtterance()).toBe(false);
    expect(s.endUtterance()).toBe(false);
    await wait(150);
    expect(h.finals).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("aborting the signal cancels the session (also if already aborted)", async () => {
    const f = await fakeAai();
    const h = harness();
    const ac = new AbortController();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, signal: ac.signal });
    await until(() => f.sockets.length === 1);
    ac.abort();
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);
    const h2 = harness();
    new AssemblyAiSttStreamingSession(cfg(f.url), h2.handlers, { sampleRate: 8000, signal: AbortSignal.abort() });
    await until(() => h2.closes() === 1);
  });

  it("close() sends Terminate and waits for Termination before releasing", async () => {
    const f = await fakeAai({ onClient: (m, ws) => m.type === "Terminate" && ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 2 })) });
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    await s.close();
    expect(f.order).toContainEqual({ type: "Terminate" });
    expect(h.closes()).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("close() still releases if the service never answers Terminate", async () => {
    const f = await fakeAai();
    const h = harness();
    const s = new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await until(() => f.sockets.length === 1);
    await s.close();
    expect(h.closes()).toBe(1);
  }, 10_000);

  it("many sessions at once stay independent", async () => {
    const f = await fakeAai({
      onClient: (m, ws) => {
        if (m.type === "ForceEndpoint") ws.send(JSON.stringify(final(`conn-${f.sockets.indexOf(ws)}`, 0)));
      },
    });
    const N = 10;
    const hs = Array.from({ length: N }, () => harness());
    const sessions = hs.map((h) => new AssemblyAiSttStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 }));
    sessions.forEach((s) => (s.startUtterance(), s.sendAudio(pcm(100)), s.endUtterance()));
    await until(() => hs.every((h) => h.finals.length === 1));
    expect(new Set(hs.map((h) => h.finals[0].text)).size).toBe(N); // each got only its own connection's answer
    sessions[0].cancel();
    expect(sessions[1].open).toBe(true);
    sessions.forEach((s) => s.cancel());
    expect(hs.every((h) => h.closes() === 1)).toBe(true);
  });
});

describe("through the provider-neutral realtime pipeline (coordinator + turn controller), unchanged", () => {
  const FRAME = 800;
  const loud = () => {
    const b = Buffer.alloc(FRAME * 2);
    for (let i = 0; i < FRAME; i++) b.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
    return b;
  };
  const quiet = () => Buffer.alloc(FRAME * 2);

  it("partials never reach the LLM; the final does, once; metrics are labelled with the provider", async () => {
    const f = await fakeAai({ onClient: forceAnswer("Can you tell me the price and location of the project?") });
    process.env.ASSEMBLYAI_API_KEY = KEY;
    process.env.ASSEMBLYAI_STT_URL = f.url;
    const stt = new ReliableSpeechToText(new AssemblyAiSttProvider());
    const call = new AbortController();
    const llm: string[] = [];
    const finished: Array<Record<string, unknown>> = [];
    const log = { info: (m: string, x?: Record<string, unknown>) => (m === "turn: finished" && finished.push(x ?? {}), undefined), warn: () => undefined };
    const ids = { callId: "call-aaaaaaaa", agentId: "a", organizationId: "o" };
    const coord = new SttStreamCoordinator({ stt, ids, sampleRate: 8000, minSpeechMs: 200, finalTimeoutMs: 5000, maxQueuedBytes: 262144, callSignal: call.signal, log });
    const ctl = new TurnController({
      ids,
      vad: new TurnDetector({ sampleRate: 8000, energyThreshold: 500, minSpeechMs: 200, endSilenceMs: 300, maxUtteranceMs: 15000, preRollMs: 200 }),
      callSignal: call.signal,
      log,
      onVadEvent: coord.onVadEvent,
      onUtteranceDropped: coord.drop,
      onVadReset: coord.onVadReset,
      runUserTurn: async (_pcm, t) => {
        const r = await coord.awaitFinal(t.utteranceRef, t.signal, t.metrics);
        if (r.text) llm.push(r.text);
      },
    });
    for (let i = 0; i < 4; i++) ctl.pushAudio(loud());
    await until(() => f.sockets.length === 1);
    f.send(partial("can you tell me", 0));
    await wait(30);
    expect(llm).toEqual([]);
    for (let i = 0; i < 3; i++) ctl.pushAudio(quiet());
    await until(() => llm.length === 1);
    expect(llm).toEqual(["Can you tell me the price and location of the project?"]);
    await until(() => finished.length === 1);
    expect(finished[0]).toMatchObject({ sttProvider: "assemblyai-stt", sttPartials: 1, outcome: "completed" });
    expect(typeof finished[0].speechEndToFinalMs).toBe("number");
    expect(typeof finished[0].speechStartToFirstPartialMs).toBe("number");
    expect(JSON.stringify(finished[0])).not.toContain("price and location"); // no transcript text in metrics
    call.abort();
  });
});
