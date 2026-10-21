/**
 * Frame decoding, VAD events, the turn state machine and the bounded outbound queue, each in isolation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { TurnDetector } from "../audio/turn-detector.js";
import { audioFormat, decodeBase64Pcm, MAX_INBOUND_FRAME_BYTES } from "./audio-format.js";
import { TurnStateMachine, type TurnState } from "./turn-state.js";
import { OutboundAudioSender, type OutboundItem } from "./outbound-audio.js";
import { TurnMetrics } from "./turn-metrics.js";
import { decodeExotelMedia, exotelMarkItem, exotelMediaItem, resolveExotelAudioFormat } from "../websocket/exotel-audio.js";

const pcm = (n: number, amp = 1000) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? -amp : amp, i * 2);
  return b;
};
const loud = () => pcm(800, 8000);
const quiet = () => Buffer.alloc(1600);

describe("internal audio format + inbound frame decoding", () => {
  it("is 16-bit LE mono PCM, no container, at a supported rate (unknown rates fall back to 8 kHz)", () => {
    expect(audioFormat(8000)).toEqual({ encoding: "pcm_s16le", channels: 1, sampleWidthBytes: 2, sampleRate: 8000 });
    expect(audioFormat(16000).sampleRate).toBe(16000);
    expect(audioFormat(44100).sampleRate).toBe(8000);
  });

  it("decodes raw PCM (no WAV header assumed) from base64", () => {
    const raw = pcm(800);
    const r = decodeBase64Pcm(raw.toString("base64"));
    expect(r.ok && r.pcm.equals(raw)).toBe(true);
    // A RIFF header is just bytes on the live path: it is not interpreted or stripped.
    const withRiff = Buffer.concat([Buffer.from("RIFF"), raw]);
    const r2 = decodeBase64Pcm(withRiff.toString("base64"));
    expect(r2.ok && r2.pcm.equals(withRiff)).toBe(true);
  });

  it.each([
    [undefined, "not_string"],
    [123, "not_string"],
    [{}, "not_string"],
    ["", "empty"],
    ["!!!!", "bad_base64"],
    ["abc", "bad_base64"], // length not a multiple of 4
    [Buffer.from([1, 2, 3]).toString("base64"), "odd_length"],
    ["A".repeat(MAX_INBOUND_FRAME_BYTES * 2), "too_large"],
  ])("rejects malformed payload %# without throwing", (payload, reason) => {
    const r = decodeBase64Pcm(payload);
    expect(r).toEqual({ ok: false, reason });
  });

  it("rejects oversized frames by length alone (no giant allocation) and honours a custom limit", () => {
    const huge = "A".repeat(50_000_000);
    const t0 = Date.now();
    expect(decodeBase64Pcm(huge)).toEqual({ ok: false, reason: "too_large" });
    expect(Date.now() - t0).toBeLessThan(50);
    expect(decodeBase64Pcm(pcm(1000).toString("base64"), 1000)).toEqual({ ok: false, reason: "too_large" });
  });

  it("Exotel adapter: resolves the call's format from start.media_format and flags surprises", () => {
    expect(resolveExotelAudioFormat({ encoding: "pcm_s16le", sample_rate: "16000" })).toMatchObject({ format: { sampleRate: 16000 }, rateFellBack: false, encodingUnexpected: false });
    expect(resolveExotelAudioFormat(undefined).format.sampleRate).toBe(8000);
    expect(resolveExotelAudioFormat({ sample_rate: 11025 })).toMatchObject({ rateFellBack: true, format: { sampleRate: 8000 } });
    expect(resolveExotelAudioFormat({ encoding: "mulaw" }).encodingUnexpected).toBe(true);
    expect(decodeExotelMedia(pcm(10).toString("base64")).ok).toBe(true);
  });

  it("Exotel adapter: outbound frames carry stream_sid, base64 audio and the right weights", () => {
    const chunk = pcm(1600);
    const media = exotelMediaItem("sid-1", chunk);
    expect(JSON.parse(media.payload)).toEqual({ event: "media", stream_sid: "sid-1", media: { payload: chunk.toString("base64") } });
    expect(media).toMatchObject({ weight: 3200, audio: true });
    const mark = exotelMarkItem("sid-1", "turn-1");
    expect(JSON.parse(mark.payload)).toEqual({ event: "mark", stream_sid: "sid-1", mark: { name: "turn-1" } });
    expect(mark).toMatchObject({ weight: 0, audio: false });
  });
});

describe("TurnDetector events (the incremental view used by turn control)", () => {
  const det = () => new TurnDetector({ sampleRate: 8000, energyThreshold: 500, minSpeechMs: 250, endSilenceMs: 300, maxUtteranceMs: 2000, preRollMs: 200 });

  it("reports silence, speech_start, speech, pause, speech_end in order", () => {
    const d = det();
    const events = [quiet(), quiet(), loud(), loud(), loud(), quiet(), loud(), quiet(), quiet(), quiet()].map((f) => d.process(f).event);
    expect(events).toEqual(["silence", "silence", "speech_start", "speech", "speech", "pause", "speech", "pause", "pause", "speech_end"]);
  });

  it("reports voiced time and trailing silence, and the utterance only at the end", () => {
    const d = det();
    d.process(loud());
    const mid = d.process(loud());
    expect(mid).toMatchObject({ event: "speech", speechMs: 200, trailingSilenceMs: 0 });
    expect(mid.utterance).toBeUndefined();
    d.process(loud());
    d.process(quiet());
    d.process(quiet());
    const end = d.process(quiet());
    expect(end).toMatchObject({ event: "speech_end", speechMs: 300, trailingSilenceMs: 300 });
    expect(end.utterance!.length).toBe(6 * 1600);
  });

  it("flags a too-short blip as discarded (no utterance)", () => {
    const d = det();
    d.process(loud());
    d.process(quiet());
    d.process(quiet());
    const end = d.process(quiet());
    expect(end.event).toBe("discarded");
    expect(end.utterance).toBeUndefined();
    expect(d.speaking).toBe(false);
  });

  it("buffer stays bounded under endless speech and is released on reset", () => {
    const d = det();
    let max = 0;
    for (let i = 0; i < 100; i++) {
      d.process(loud());
      max = Math.max(max, d.bufferedBytes);
    }
    expect(max).toBeLessThanOrEqual(2000 * 16 + 1600); // maxUtteranceMs of 8 kHz PCM (+ one frame)
    d.process(loud());
    d.reset();
    expect(d.bufferedBytes).toBe(0);
  });

  it("push() keeps its original contract", () => {
    const d = det();
    expect(d.push(loud())).toBeNull();
    d.push(loud());
    d.push(loud());
    let out: Buffer | null = null;
    for (let i = 0; i < 3; i++) out = d.push(quiet()) ?? out;
    expect(out!.length).toBe(6 * 1600);
  });
});

describe("TurnStateMachine", () => {
  it("walks the documented happy path and the barge-in path", () => {
    const m = new TurnStateMachine();
    for (const s of ["USER_SPEAKING", "USER_SILENCE", "PROCESSING", "AI_SPEAKING", "IDLE"] as TurnState[]) expect(m.transition(s, "t")).toBe(true);
    for (const s of ["PROCESSING", "AI_SPEAKING", "INTERRUPTED", "USER_SPEAKING"] as TurnState[]) expect(m.transition(s, "t")).toBe(true);
    expect(m.state).toBe("USER_SPEAKING");
  });

  it("refuses illegal moves and leaves the state unchanged", () => {
    const m = new TurnStateMachine();
    expect(m.transition("AI_SPEAKING", "greeting")).toBe(true);
    expect(m.transition("USER_SILENCE", "bad")).toBe(false);
    expect(m.transition("PROCESSING", "bad")).toBe(false);
    expect(m.state).toBe("AI_SPEAKING");
    const idle = new TurnStateMachine();
    expect(idle.transition("INTERRUPTED", "nothing to interrupt")).toBe(false);
    expect(idle.state).toBe("IDLE");
  });

  it("CLOSED is terminal; same-state is a harmless no-op; history is bounded", () => {
    const changes: string[] = [];
    const m = new TurnStateMachine((c) => changes.push(`${c.from}>${c.to}`));
    expect(m.transition("IDLE", "noop")).toBe(true);
    expect(changes).toEqual([]);
    for (let i = 0; i < 50; i++) {
      m.transition("USER_SPEAKING", "a");
      m.transition("IDLE", "b");
    }
    expect(m.history.length).toBe(32);
    expect(m.transition("CLOSED", "end")).toBe(true);
    for (const s of ["IDLE", "USER_SPEAKING", "PROCESSING", "AI_SPEAKING"] as TurnState[]) expect(m.transition(s, "x")).toBe(false);
  });
});

describe("TurnMetrics", () => {
  it("derives latencies, keeps the first stamp of a stage, and carries only ids/timings (no content)", () => {
    let t = 100;
    const m = new TurnMetrics("t1", "user", { callId: "c", agentId: "a", organizationId: "o" }, () => t);
    m.mark("speechStart", 100);
    m.mark("speechEnd", 600);
    m.mark("sttStart", 610);
    m.mark("sttEnd", 900);
    m.mark("sttEnd", 9999); // ignored: already stamped
    m.mark("llmStart", 900);
    m.mark("llmEnd", 1400);
    m.mark("ttsStart", 1400);
    m.mark("firstAudioByte", 1700);
    m.mark("ttsEnd", 1800);
    t = 2500;
    m.endedAt = t;
    m.outcome = "completed";
    expect(m.summary()).toMatchObject({
      userSpeechMs: 500,
      sttMs: 290,
      speechEndToSttEndMs: 300,
      llmMs: 500,
      ttsMs: 400,
      ttsToFirstAudioMs: 300,
      speechEndToFirstAudioMs: 1100,
      turnMs: 2400,
      callId: "c",
      agentId: "a",
      organizationId: "o",
    });
    const keys = Object.keys(m.summary()).join(",");
    expect(keys).not.toMatch(/audio(?!Byte|ms)|pcm|transcript|prompt|text|key/i);
  });
});

describe("OutboundAudioSender (bounded, cancellable outbound audio)", () => {
  afterEach(() => vi.useRealTimers());
  const item = (n: number, audio = true): OutboundItem => ({ payload: `p${n}`, weight: audio ? 3200 : 0, audio });

  function make(over: Partial<ConstructorParameters<typeof OutboundAudioSender>[0]> = {}) {
    const sent: string[] = [];
    let buffered = 0;
    const firsts: number[] = [];
    const s = new OutboundAudioSender({
      send: (p) => void sent.push(p),
      bufferedAmount: () => buffered,
      maxQueuedBytes: 32_000,
      highWaterBytes: 10_000,
      retryMs: 5,
      onFirstAudioSent: () => void firsts.push(sent.length),
      ...over,
    });
    return { s, sent, firsts, setBuffered: (n: number) => (buffered = n) };
  }

  it("sends in order, flags first audio once per burst, and goes idle", async () => {
    const { s, sent, firsts } = make();
    expect(s.enqueue([item(1), item(2), item(3, false)])).toBe(true);
    expect(sent).toEqual(["p1", "p2", "p3"]);
    expect(firsts).toEqual([1]);
    await s.idle();
    s.enqueue([item(4)]);
    expect(firsts).toEqual([1, 4]);
  });

  it("holds frames back while the socket is congested and resumes when it drains", async () => {
    vi.useFakeTimers();
    const { s, sent, setBuffered } = make();
    setBuffered(50_000);
    s.enqueue([item(1), item(2)]);
    expect(sent).toEqual([]);
    expect(s.length).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]); // still congested
    setBuffered(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(["p1", "p2"]);
  });

  it("refuses a batch that would exceed the cap, all-or-nothing", () => {
    const { s, sent, setBuffered } = make();
    setBuffered(50_000); // keep everything queued
    expect(s.enqueue(Array.from({ length: 8 }, (_, i) => item(i)))).toBe(true); // 25,600
    expect(s.enqueue([item(100), item(101), item(102)])).toBe(false); // +9,600 > 32,000
    expect(s.queuedWeight).toBe(25_600);
    expect(s.length).toBe(8);
    expect(sent).toEqual([]);
  });

  it("clear() drops everything unsent, resolves idle(), and later audio still works (barge-in)", async () => {
    const { s, sent, setBuffered } = make();
    setBuffered(50_000);
    s.enqueue([item(1), item(2), item(3)]);
    const idle = s.idle();
    expect(s.clear()).toBe(9600);
    await idle;
    expect(s.length).toBe(0);
    expect(s.clearedFrames).toBe(3);
    setBuffered(0);
    s.enqueue([item(9)]);
    expect(sent).toEqual(["p9"]);
  });

  it("close() discards the queue and refuses further audio; a dead transport empties it too", () => {
    const a = make();
    a.setBuffered(50_000);
    a.s.enqueue([item(1)]);
    a.s.close();
    expect(a.s.length).toBe(0);
    expect(a.s.enqueue([item(2)])).toBe(false);

    const dead = make({
      send: () => {
        throw new Error("socket closed");
      },
    });
    expect(dead.s.enqueue([item(1), item(2)])).toBe(true); // does not throw
    expect(dead.s.length).toBe(0);
  });
});

describe("TurnMetrics field names survive the logger's secret scrubbing", () => {
  it("no summary key matches the logger's secret-key pattern (a key like '...Token...' would be logged as [redacted])", async () => {
    const { scrubFields } = await import("../shared/logger.js");
    const m = new TurnMetrics("t", "user", { callId: "c" }, () => 0);
    m.llmHops = 1;
    m.llmToolCalls = 0;
    m.llmChunks = 2;
    m.llmChars = 40;
    m.llmStreamed = true;
    m.llmFinishReason = "stop";
    m.llmCompletionToks = 9;
    m.set("llmHopStart", 10);
    m.set("llmFirstToken", 30);
    m.set("llmFirstChunk", 30);
    m.set("llmStart", 0);
    m.set("llmEnd", 50);
    m.set("sttEnd", 0);
    const summary = m.summary();
    const scrubbed = scrubFields(summary) as Record<string, unknown>;
    for (const [k, v] of Object.entries(summary)) expect(scrubbed[k], `field ${k} was altered by the logger`).toEqual(v);
    expect(summary).toMatchObject({ llmToFirstDeltaMs: 20, llmFirstDeltaToFirstChunkMs: 0 });
  });
});
