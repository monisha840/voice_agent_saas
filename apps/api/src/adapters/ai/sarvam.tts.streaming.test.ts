/**
 * Contract tests for the Sarvam streaming TTS adapter: the REAL adapter against a local WebSocket server that speaks
 * Sarvam's documented protocol (docs.sarvam.ai: text-to-speech/ws). No credentials or internet.
 * What these prove is that we follow the documented contract; they cannot prove Sarvam behaves as documented.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { SarvamTtsStreamingSession, type SarvamTtsStreamConfig } from "./sarvam.tts.streaming.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import type { TtsStreamHandlers } from "./tts.interface.js";
import { ProviderConfigError, type ProviderRequestError } from "../../shared/errors.js";
import { pcm16ToWav } from "../../audio/pcm.js";

interface Fake {
  url: string;
  received: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  requests: IncomingMessage[];
  sockets: ServerSocket[];
  send(msg: unknown): void;
  close(): Promise<void>;
}
const servers: Fake[] = [];
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function fakeSarvam(opts: { refuse?: number } = {}): Promise<Fake> {
  const received: Fake["received"] = [];
  const requests: IncomingMessage[] = [];
  const sockets: ServerSocket[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: opts.refuse ? (_i, cb) => cb(false, opts.refuse, "no") : undefined,
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws, req) => {
    requests.push(req);
    sockets.push(ws);
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  });
  const fake: Fake = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/text-to-speech/ws`,
    received,
    requests,
    sockets,
    send: (m) => sockets[0].send(JSON.stringify(m)),
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
  vi.restoreAllMocks();
  delete process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_TTS_STREAM_URL;
});

const cfg = (url: string, over: Partial<SarvamTtsStreamConfig> = {}): SarvamTtsStreamConfig => ({
  apiKey: "test-key",
  url,
  model: "bulbul:v3",
  defaultSpeaker: "shubh",
  connectTimeoutMs: 1000,
  ...over,
});

function harness() {
  const audio: Buffer[] = [];
  const order: string[] = [];
  const errors: ProviderRequestError[] = [];
  let closes = 0;
  const handlers: TtsStreamHandlers = {
    onAudio: (p) => {
      audio.push(p);
      order.push("audio");
    },
    onSegmentComplete: () => void order.push("done"),
    onError: (e) => void errors.push(e as ProviderRequestError),
    onClose: () => void closes++,
  };
  return { handlers, audio, order, errors, closes: () => closes };
}
const audioMsg = (pcm: Buffer) => ({ type: "audio", data: { content_type: "audio/wav", audio: pcm.toString("base64"), request_id: "r1" } });
const finalEvt = { type: "event", data: { event_type: "final", message: "done", timestamp: "2026-01-01T00:00:00Z" } };

describe("SarvamTtsStreamingSession", () => {
  it("connects with the key in a header (not the URL), the model in the query, and sends config FIRST with the voice", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, languageCode: "ta-IN", voice: "meera" });
    s.sendText("வணக்கம்."); // queued while connecting
    await tick();
    const req = f.requests[0];
    expect(req.headers["api-subscription-key"]).toBe("test-key");
    expect(req.url).toContain("model=bulbul%3Av3");
    expect(req.url).toContain("send_completion_event=true");
    expect(req.url).not.toContain("test-key");
    expect(f.received[0]).toEqual({
      type: "config",
      data: { language_code: "ta-IN", speaker: "meera", model: "bulbul:v3", speech_sample_rate: 8000, output_audio_codec: "linear16" },
    });
    expect(f.received.slice(1)).toEqual([{ type: "text", data: { text: "வணக்கம்." } }, { type: "flush" }]);
    s.cancel();
  });

  it("with no configured voice uses the provider default speaker; language defaults to en-IN", async () => {
    const f = await fakeSarvam();
    const s = new SarvamTtsStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    await tick();
    expect(f.received[0].data).toMatchObject({ speaker: "shubh", language_code: "en-IN" });
    s.cancel();
  });

  it("sends one text + one flush per sentence immediately once open, in order", async () => {
    const f = await fakeSarvam();
    const s = new SarvamTtsStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    await tick();
    s.sendText("One.");
    s.sendText("Two.");
    await tick();
    expect(f.received.slice(1).map((m) => m.type)).toEqual(["text", "flush", "text", "flush"]);
    expect(f.received.filter((m) => m.type === "text").map((m) => m.data.text)).toEqual(["One.", "Two."]);
    s.cancel();
  });

  it("splits text beyond the documented 2500-character limit but flushes once", async () => {
    const f = await fakeSarvam();
    const s = new SarvamTtsStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    await tick();
    s.sendText("a".repeat(5200));
    await tick();
    expect(f.received.filter((m) => m.type === "text").map((m) => m.data.text.length)).toEqual([2500, 2500, 200]);
    expect(f.received.filter((m) => m.type === "flush")).toHaveLength(1);
    s.cancel();
  });

  it("delivers raw PCM chunks in order, one completion per flush, and keeps an odd trailing byte for the next chunk", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.sendText("One.");
    s.sendText("Two.");
    await tick();
    f.send(audioMsg(Buffer.from([1, 0, 2, 0, 3]))); // 5 bytes: the odd one is carried
    f.send(audioMsg(Buffer.from([0, 4, 0])));
    f.send(finalEvt);
    f.send(audioMsg(Buffer.from([9, 0])));
    f.send(finalEvt);
    await tick();
    expect(h.audio.map((b) => [...b])).toEqual([[1, 0, 2, 0], [3, 0, 4, 0], [9, 0]]);
    expect(h.order).toEqual(["audio", "audio", "done", "audio", "done"]);
    s.cancel();
  });

  it("accepts WAV-wrapped chunks (header stripped) and resamples when the rate differs", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick();
    const pcm16k = Buffer.alloc(1600); // 50 ms @ 16 kHz
    f.send(audioMsg(pcm16ToWav(pcm16k, 16000)));
    f.send(audioMsg(pcm16ToWav(Buffer.alloc(800), 8000)));
    await tick();
    expect(h.audio.map((b) => b.length)).toEqual([800, 800]);
    s.cancel();
  });

  it("close() ends the session only after outstanding text is synthesized (and immediately when nothing is outstanding)", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick();
    s.sendText("One.");
    let closed = false;
    void s.close().then(() => (closed = true));
    await tick();
    expect(closed).toBe(false);
    f.send(audioMsg(Buffer.alloc(100)));
    f.send(finalEvt);
    await tick();
    expect(closed).toBe(true);
    expect(h.audio).toHaveLength(1);
    expect(h.closes()).toBe(1);
    expect(s.open).toBe(false);

    const idle = new SarvamTtsStreamingSession(cfg(f.url), harness().handlers, { sampleRate: 8000 });
    await tick();
    await idle.close();
    expect(idle.open).toBe(false);
  });

  it("cancel() terminates the socket at once, silences the handlers and emits onClose exactly once", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    s.sendText("One.");
    await tick();
    s.cancel();
    s.cancel();
    expect(s.open).toBe(false);
    expect(s.sendText("more")).toBe(false);
    await tick();
    expect(f.sockets[0].readyState).toBeGreaterThanOrEqual(2); // closing / closed
    expect(h.closes()).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("an aborted signal cancels the session (also when already aborted) and removes its listener", async () => {
    const f = await fakeSarvam();
    const ac = new AbortController();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000, signal: ac.signal });
    await tick();
    ac.abort();
    expect(s.open).toBe(false);
    expect(h.closes()).toBe(1);

    const pre = new AbortController();
    pre.abort();
    const h2 = harness();
    const s2 = new SarvamTtsStreamingSession(cfg(f.url), h2.handlers, { sampleRate: 8000, signal: pre.signal });
    await tick();
    expect(s2.open).toBe(false);
    expect(h2.closes()).toBe(1);
  });

  it("a provider error message maps to a category by its code; its text is never copied", async () => {
    const f = await fakeSarvam();
    const h = harness();
    new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick();
    f.send({ type: "error", data: { message: "speaker 'secret words' is invalid", code: 400, request_id: "r" } });
    await tick();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].category).toBe("invalid_request");
    expect(h.errors[0].status).toBe(400);
    expect(h.errors[0].message).not.toContain("secret words");
    expect(h.closes()).toBe(1);

    const f2 = await fakeSarvam();
    const h2 = harness();
    new SarvamTtsStreamingSession(cfg(f2.url), h2.handlers, { sampleRate: 8000 });
    await tick();
    f2.send({ type: "error", data: { message: "x", code: 429 } });
    await tick();
    expect(h2.errors[0].category).toBe("rate_limited");
  });

  it("malformed audio / non-JSON frames fail the session as bad_response", async () => {
    const f = await fakeSarvam();
    const h = harness();
    new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick();
    f.send({ type: "audio", data: {} });
    await tick();
    expect(h.errors[0].category).toBe("bad_response");

    const f2 = await fakeSarvam();
    const h2 = harness();
    new SarvamTtsStreamingSession(cfg(f2.url), h2.handlers, { sampleRate: 8000 });
    await tick();
    f2.sockets[0].send("not json");
    await tick();
    expect(h2.errors[0].category).toBe("bad_response");
  });

  it("a connection refused with HTTP 401 is an auth error; an unreachable server is a network error", async () => {
    const f = await fakeSarvam({ refuse: 401 });
    const h = harness();
    new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick(80);
    expect(h.errors[0].category).toBe("auth");

    const h2 = harness();
    new SarvamTtsStreamingSession(cfg("ws://127.0.0.1:1/text-to-speech/ws"), h2.handlers, { sampleRate: 8000 });
    await tick(150);
    expect(h2.errors[0].category).toBe("network");
    expect(h2.closes()).toBe(1);
  });

  it("times out when the connection never opens (bounded), with no timer left", async () => {
    // A TCP server that accepts and never completes the WebSocket handshake.
    const net = await import("node:net");
    const srv = net.createServer(() => undefined);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const h = harness();
    new SarvamTtsStreamingSession(cfg(`ws://127.0.0.1:${port}/x`, { connectTimeoutMs: 60 }), h.handlers, { sampleRate: 8000 });
    await tick(200);
    srv.close();
    expect(h.errors[0].category).toBe("timeout");
    expect(h.closes()).toBe(1);
  });

  it("a provider-side close while text is outstanding is an error; with nothing outstanding it is quiet", async () => {
    const f = await fakeSarvam();
    const h = harness();
    const s = new SarvamTtsStreamingSession(cfg(f.url), h.handlers, { sampleRate: 8000 });
    await tick();
    s.sendText("One.");
    await tick();
    f.sockets[0].close(1011);
    await tick();
    expect(h.errors[0].category).toBe("server");

    const f2 = await fakeSarvam();
    const h2 = harness();
    new SarvamTtsStreamingSession(cfg(f2.url), h2.handlers, { sampleRate: 8000 });
    await tick();
    f2.sockets[0].close(1000);
    await tick();
    expect(h2.errors).toEqual([]);
    expect(h2.closes()).toBe(1);
  });

  it("is a provider: the real SarvamTtsProvider advertises streaming and refuses to stream without a key", async () => {
    const p = new SarvamTtsProvider();
    expect(p.capabilities.streamingTts).toBe(true);
    delete process.env.SARVAM_API_KEY;
    await expect(p.startStreaming({ ...harness().handlers }, { sampleRate: 8000 })).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("the provider passes the configured voice and URL through to the wire", async () => {
    const f = await fakeSarvam();
    process.env.SARVAM_API_KEY = "k-123";
    process.env.SARVAM_TTS_STREAM_URL = f.url;
    const s = await new SarvamTtsProvider().startStreaming(harness().handlers, { sampleRate: 8000, languageCode: "hi-IN", voice: "priya" });
    await tick();
    expect(f.requests[0].headers["api-subscription-key"]).toBe("k-123");
    expect(f.received[0].data).toMatchObject({ speaker: "priya", language_code: "hi-IN" });
    s.cancel();
  });
});
