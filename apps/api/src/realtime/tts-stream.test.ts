/**
 * StreamingSpeaker: ordering, rechunking, bounded output, cancellation at every stage, fallbacks that never repeat
 * audio, and cleanup. A scripted fake provider is driven by hand (the test decides when audio / completion / errors
 * arrive); the outbound queue is the REAL OutboundAudioSender. No sockets, no database.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { getEventListeners } from "node:events";
import { ProviderRequestError, type ProviderFailureCategory } from "../shared/errors.js";
import type { ITextToSpeech, TtsResult, TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions, TtsOptions } from "../adapters/ai/tts.interface.js";
import { OutboundAudioSender, type OutboundItem } from "./outbound-audio.js";
import { StreamingSpeaker } from "./tts-stream.js";
import { TurnMetrics } from "./turn-metrics.js";
import type { TurnContext } from "./turn-controller.js";

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (category: ProviderFailureCategory) => new ProviderRequestError("fake", `fake ${category}`, undefined, { category, operation: "tts.stream" });

/** PCM whose every sample is `n`, so a chunk's origin can be read back from the wire. */
const fill = (n: number, bytes: number) => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) b.writeInt16LE(n, i);
  return b;
};
const wav = (pcm: Buffer) => pcm;

class FakeSession implements TtsStreamingSession {
  texts: string[] = [];
  open = true;
  cancelled = false;
  closed = false;
  constructor(
    readonly handlers: TtsStreamHandlers,
    readonly opts: TtsStreamOptions,
  ) {}
  sendText(t: string) {
    if (!this.open) return false;
    this.texts.push(t);
    return true;
  }
  cancel() {
    if (!this.open) return;
    this.open = false;
    this.cancelled = true;
    this.handlers.onClose();
  }
  async close() {
    if (!this.open) return;
    this.open = false;
    this.closed = true;
    this.handlers.onClose();
  }
  audio(pcm: Buffer) {
    this.handlers.onAudio(pcm);
  }
  done() {
    this.handlers.onSegmentComplete();
  }
  fail(c: ProviderFailureCategory) {
    this.handlers.onError(err(c));
  }
}

class FakeTts implements ITextToSpeech {
  readonly name = "fake-tts";
  readonly capabilities = { voiceSelection: true, streamingTts: true };
  sessions: FakeSession[] = [];
  batch: Array<{ text: string; voice?: string }> = [];
  /** Per-sentence batch behaviour. */
  batchDelay: (text: string) => number = () => 0;
  batchFill: (text: string) => number = (t) => Number(t.replace(/\D/g, "")) || 1;
  batchFail?: (text: string, voice?: string) => Error | undefined;
  async startStreaming(handlers: TtsStreamHandlers, opts: TtsStreamOptions) {
    const s = new FakeSession(handlers, opts);
    this.sessions.push(s);
    return s;
  }
  async synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
    this.batch.push({ text, voice: opts?.voice });
    await wait(this.batchDelay(text));
    const e = this.batchFail?.(text, opts?.voice);
    if (e) throw e;
    return { audio: wav(fill(this.batchFill(text), 4000)), format: "wav" };
  }
}

function rig(opts: { maxQueuedBytes?: number; maxHeldBytes?: number; buffered?: () => number; voice?: string; preAbort?: boolean; tts?: FakeTts; sharedSender?: OutboundAudioSender } = {}) {
  const tts = opts.tts ?? new FakeTts();
  const abort = new AbortController();
  if (opts.preAbort) abort.abort();
  const wire: string[] = [];
  let buffered = 0;
  const sender = opts.sharedSender ?? new OutboundAudioSender({
    send: (p) => void wire.push(p),
    bufferedAmount: opts.buffered ?? (() => buffered),
    maxQueuedBytes: opts.maxQueuedBytes ?? 1_000_000,
    highWaterBytes: 1000,
    retryMs: 5,
  });
  const metrics = new TurnMetrics("t1", "user", { callId: "call-1" }, Date.now);
  let speaking = 0;
  const turn: TurnContext = {
    turnId: "t1",
    kind: "user",
    signal: abort.signal,
    isActive: () => !abort.signal.aborted,
    metrics,
    utteranceRef: undefined,
    beginAiSpeaking: () => {
      speaking++;
      return !abort.signal.aborted;
    },
    endAiSpeaking: () => undefined,
  };
  let marks = 0;
  const speaker = new StreamingSpeaker({
    tts,
    turn,
    sender,
    sampleRate: 8000,
    languageCode: "ta-IN",
    voice: opts.voice,
    callId: "call-1",
    generation: sender.generation,
    maxHeldBytes: opts.maxHeldBytes ?? 1_000_000,
    audioItem: (pcm): OutboundItem => ({ payload: `A${pcm.readInt16LE(0)}:${pcm.length}`, weight: pcm.length, audio: true }),
    markItem: (name): OutboundItem => ({ payload: `M:${name}`, weight: 0, audio: false }),
    nextMarkName: () => `m${++marks}`,
    waitForPlayback: async () => undefined,
  });
  return {
    tts,
    speaker,
    wire,
    sender,
    metrics,
    abort,
    speaking: () => speaking,
    setBuffered: (n: number) => void (buffered = n),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("StreamingSpeaker: lifecycle and audio", () => {
  it("opens a session, sends the sentence at once, plays audio, queues the mark last and cleans up", async () => {
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    expect(s).toBeDefined();
    expect(getEventListeners(r.abort.signal, "abort").length).toBeGreaterThan(0);

    r.speaker.push("Hello Rajesh.");
    expect(s.texts).toEqual(["Hello Rajesh."]);
    expect(r.metrics.stamps.ttsStart).toBeDefined();
    expect(r.metrics.stamps.ttsFirstAudio).toBeUndefined();

    const finished = r.speaker.finish();
    s.audio(fill(1, 3200)); // first audio chunk
    expect(r.metrics.stamps.ttsFirstAudio).toBeDefined();
    expect(r.speaking()).toBe(1);
    expect(r.wire).toEqual(["A1:3200"]);
    s.done();
    await finished;

    expect(r.wire).toEqual(["A1:3200", "M:m1"]);
    expect(r.metrics.stamps.ttsEnd).toBeDefined();
    expect(s.closed).toBe(true); // graceful close, not a cancel
    expect(getEventListeners(r.abort.signal, "abort").length).toBe(0);
    expect(r.speaker.error).toBeUndefined();
  });

  it("re-chunks arbitrary provider audio into 3200-byte frames and pads only the very end", async () => {
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("One.");
    s.audio(fill(1, 5000));
    s.audio(fill(1, 4600)); // 9600 total = 3 full frames
    s.done();
    r.speaker.push("Two.");
    s.audio(fill(2, 1000)); // sentence 2's audio continues the same stream
    s.done();
    await r.speaker.finish();
    expect(r.wire).toEqual(["A1:3200", "A1:3200", "A1:3200", "A2:3200", "M:m1"]); // 1000 B tail padded to one frame
    expect(r.speaker.audioMs).toBeCloseTo((10600 / 2 / 8000) * 1000);
  });

  it("sends sentences in order, including ones pushed before the provider session is ready", async () => {
    const r = rig();
    r.speaker.push("First.");
    r.speaker.push("Second.");
    expect(r.tts.sessions[0].texts).toEqual([]); // session still opening: nothing sent yet
    await tick();
    r.speaker.push("Third.");
    expect(r.tts.sessions[0].texts).toEqual(["First.", "Second.", "Third."]);
    r.speaker.cancel();
  });

  it("audio of sentence N is on the wire before audio of sentence N+1 even when completions lag", async () => {
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("A.");
    r.speaker.push("B.");
    s.audio(fill(1, 3200));
    s.audio(fill(2, 3200));
    s.done();
    s.done();
    await r.speaker.finish();
    expect(r.wire.filter((w) => w.startsWith("A"))).toEqual(["A1:3200", "A2:3200"]);
  });

  it("a reply with no audio at all queues nothing and still finishes", async () => {
    const r = rig();
    await tick();
    r.speaker.push("Silent.");
    r.tts.sessions[0].done();
    await r.speaker.finish();
    expect(r.wire).toEqual([]);
  });
});

describe("StreamingSpeaker: cancellation", () => {
  it("cancelled before TTS starts: no provider session is ever opened", async () => {
    const r = rig({ preAbort: true });
    r.speaker.push("Never spoken.");
    await r.speaker.finish();
    await tick();
    expect(r.tts.sessions).toHaveLength(0);
    expect(r.wire).toEqual([]);
  });

  it("cancelled while the session is still opening: the session is cancelled as soon as it exists", async () => {
    const r = rig();
    r.speaker.push("Hi.");
    r.abort.abort(); // before startStreaming resolved
    await tick();
    expect(r.tts.sessions[0].cancelled).toBe(true);
    expect(r.tts.sessions[0].texts).toEqual([]);
  });

  it("cancelled during synthesis (no audio yet): provider cancelled, finish() resolves, nothing is queued, late audio is ignored", async () => {
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("Hello.");
    const finished = r.speaker.finish();
    r.abort.abort();
    await finished;
    expect(s.cancelled).toBe(true);
    s.handlers.onAudio(fill(1, 3200)); // a straggler from the provider
    s.handlers.onSegmentComplete();
    expect(r.wire).toEqual([]);
    expect(r.speaking()).toBe(0);
    expect(getEventListeners(r.abort.signal, "abort").length).toBe(0);
  });

  it("cancelled after partial audio: queued audio of the reply is discarded, no mark, no further audio", async () => {
    const r = rig();
    r.setBuffered(10_000); // congested socket: frames stay in OUR queue
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("Long reply.");
    s.audio(fill(1, 9600)); // 3 frames queued, none sent
    expect(r.sender.length).toBe(3);
    const finished = r.speaker.finish();
    r.abort.abort();
    await finished;
    expect(r.sender.length).toBe(0); // discarded, never reaches the caller
    expect(r.sender.clearedFrames).toBe(3);
    s.handlers.onAudio(fill(1, 3200));
    r.setBuffered(0);
    await wait(15);
    expect(r.wire).toEqual([]);
    expect(s.cancelled).toBe(true);
  });

  it("a cancelled reply's audio never leaks into the NEXT turn's speaker", async () => {
    const tts = new FakeTts();
    const a = rig({ tts });
    await tick();
    const oldSession = tts.sessions[0];
    a.speaker.push("Old reply.");
    a.abort.abort();
    const b = rig({ tts });
    await tick();
    b.speaker.push("New reply.");
    oldSession.handlers.onAudio(fill(9, 3200)); // old provider session still talking
    tts.sessions[1].audio(fill(2, 3200));
    tts.sessions[1].done();
    await b.speaker.finish();
    expect(b.wire).toEqual(["A2:3200", "M:m1"]);
    expect(a.wire).toEqual([]);
  });
});

describe("StreamingSpeaker: output generations (barge-in safety)", () => {
  it("audio arriving after the output was cleared for a newer turn is refused and ends the reply", async () => {
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("Old reply.");
    r.sender.clear(); // barge-in: the output moves on to a new generation
    s.audio(fill(1, 3200)); // the provider still talks
    expect(r.wire).toEqual([]);
    expect(r.sender.length).toBe(0);
    expect(s.cancelled).toBe(true);
    expect(r.speaking()).toBe(0); // a dead turn never even starts speaking
    await r.speaker.finish();
  });

  it("an old speaker's late cancel does not wipe the NEXT turn's queued audio", async () => {
    const tts = new FakeTts();
    const a = rig({ tts });
    a.setBuffered(10_000);
    await tick();
    a.speaker.push("A.");
    a.tts.sessions[0].audio(fill(1, 3200));
    a.sender.clear(); // interruption: output generation advances (turn A is dead)
    // Turn B starts on the same sender and queues audio.
    const b = rig({ tts, sharedSender: a.sender });
    b.speaker.push("B.");
    await tick();
    tts.sessions[1].audio(fill(2, 3200));
    expect(a.sender.length).toBe(1);
    a.speaker.cancel(); // A's cleanup arrives late
    expect(a.sender.length).toBe(1); // B's frame is untouched
    b.speaker.cancel();
  });
});

describe("StreamingSpeaker: failures", () => {
  it("passes the configured voice to the provider; no voice means the provider default", async () => {
    const a = rig({ voice: "meera" });
    await tick();
    expect(a.tts.sessions[0].opts).toMatchObject({ voice: "meera", languageCode: "ta-IN", sampleRate: 8000, callId: "call-1" });
    a.speaker.cancel();
    const b = rig();
    await tick();
    expect(b.tts.sessions[0].opts.voice).toBeUndefined();
    b.speaker.cancel();
  });

  it("an invalid voice is answered with ONE re-open on the default voice (sentences re-sent, no batch)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = rig({ voice: "nonexistent" });
    await tick();
    r.speaker.push("One.");
    r.speaker.push("Two.");
    r.tts.sessions[0].fail("invalid_request");
    await tick();
    expect(r.tts.sessions[0].cancelled).toBe(true);
    const s2 = r.tts.sessions[1];
    expect(s2.opts.voice).toBeUndefined();
    expect(s2.texts).toEqual(["One.", "Two."]);
    expect(r.speaker.fallback).toBe("voice");
    s2.audio(fill(1, 3200));
    s2.done();
    s2.done();
    await r.speaker.finish();
    expect(r.tts.batch).toEqual([]);
    expect(r.wire).toEqual(["A1:3200", "M:m1"]);
    expect(r.speaker.error).toBeUndefined();
  });

  it("a rejected default voice does not loop: it falls through to batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = rig({ voice: "bad" });
    await tick();
    r.speaker.push("One.");
    r.tts.sessions[0].fail("invalid_request");
    await tick();
    r.tts.sessions[1].fail("invalid_request");
    await tick();
    expect(r.tts.sessions).toHaveLength(2);
    expect(r.tts.batch).toHaveLength(1);
    await r.speaker.finish();
  });

  it("provider error before any audio: the reply is produced by batch synthesis, in order, even when sentence 1 is slower", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tts = new FakeTts();
    tts.batchDelay = (t) => (t.includes("1") ? 30 : 0);
    const r = rig({ tts });
    await tick();
    r.speaker.push("Sentence 1.");
    r.speaker.push("Sentence 2.");
    tts.sessions[0].fail("server");
    await tick();
    r.speaker.push("Sentence 3."); // pushed after the switch
    await r.speaker.finish();
    expect(tts.batch.map((b) => b.text)).toEqual(["Sentence 1.", "Sentence 2.", "Sentence 3."]);
    expect(r.wire.filter((w) => w.startsWith("A")).map((w) => w.slice(0, 2))).toEqual(["A1", "A1", "A2", "A3"]); // 3 x 4000 B re-framed to 3200 B
    expect(r.speaker.fallback).toBe("batch");
    expect(r.speaker.error).toBeUndefined();
  });

  it("provider timeout before any audio also falls back; a batch failure then ends the reply with the error recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tts = new FakeTts();
    tts.batchFail = () => err("timeout");
    const r = rig({ tts });
    await tick();
    r.speaker.push("Hello.");
    tts.sessions[0].fail("timeout");
    await r.speaker.finish();
    expect(r.wire).toEqual([]);
    expect(r.speaker.error).toBeInstanceOf(ProviderRequestError);
    expect((r.speaker.error as ProviderRequestError).category).toBe("timeout");
  });

  it("failure AFTER partial audio is never retried or replayed: what was delivered stands, the mark is still sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = rig();
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("One.");
    r.speaker.push("Two.");
    s.audio(fill(1, 3200));
    s.fail("server");
    await r.speaker.finish();
    expect(r.tts.sessions).toHaveLength(1); // no second stream
    expect(r.tts.batch).toEqual([]); // no batch replay
    expect(r.wire).toEqual(["A1:3200", "M:m1"]);
    expect((r.speaker.error as ProviderRequestError).category).toBe("server");
  });
});

describe("StreamingSpeaker: backpressure and bounds", () => {
  it("holds audio the outbound queue refuses, keeps order, and releases it as the queue drains", async () => {
    const r = rig({ maxQueuedBytes: 6400 });
    r.setBuffered(10_000); // nothing is handed to the socket yet
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("Big.");
    for (let n = 1; n <= 5; n++) s.audio(fill(n, 3200)); // queue takes 2 frames, the other 3 are held
    expect(r.sender.length).toBe(2);
    expect(r.wire).toEqual([]);
    s.done();
    const finished = r.speaker.finish();
    r.setBuffered(0); // the socket drains
    await finished;
    await wait(40);
    expect(r.wire).toEqual(["A1:3200", "A2:3200", "A3:3200", "A4:3200", "A5:3200", "M:m1"]);
  });

  it("is bounded: audio beyond the hold limit fails the reply instead of growing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = rig({ maxQueuedBytes: 3200, maxHeldBytes: 6400 });
    r.setBuffered(10_000);
    await tick();
    const s = r.tts.sessions[0];
    r.speaker.push("Flood.");
    for (let n = 1; n <= 6; n++) s.audio(fill(n, 3200)); // 1 queued + 2 held, the 4th held chunk breaks the cap
    await r.speaker.finish();
    expect(r.speaker.error).toBeInstanceOf(Error);
    expect(r.sender.queuedWeight).toBeLessThanOrEqual(3200); // never more than the queue cap
    expect(s.cancelled).toBe(true);
  });
});

describe("StreamingSpeaker: resources", () => {
  it("leaves no timers or listeners behind after a cancel with held audio", async () => {
    vi.useFakeTimers();
    try {
      const r = rig({ maxQueuedBytes: 3200 });
      r.setBuffered(10_000);
      await vi.advanceTimersByTimeAsync(1);
      const baseline = vi.getTimerCount(); // timers of other things in this process are not ours
      const s = r.tts.sessions[0];
      r.speaker.push("x.");
      s.audio(fill(1, 6400)); // 1 queued, 1 held -> a drain timer is scheduled
      expect(vi.getTimerCount()).toBeGreaterThan(baseline);
      r.speaker.cancel();
      r.sender.close();
      expect(vi.getTimerCount()).toBe(baseline);
      expect(getEventListeners(r.abort.signal, "abort").length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
