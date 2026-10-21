/**
 * Streaming-STT coordination, end to end through the REAL TurnDetector + TurnController, with a scripted fake
 * streaming provider. Deterministic: fake clock, no sockets, no database. The "LLM" is a function that records what
 * text it was asked to answer, so "partial does not trigger the LLM" and "final triggers exactly one" are asserted
 * on the real hand-off point.
 */
import { describe, it, expect } from "vitest";
import { TurnDetector } from "../audio/turn-detector.js";
import type { ISpeechToText, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "../adapters/ai/stt.interface.js";
import { ProviderRequestError } from "../shared/errors.js";
import { TurnController } from "./turn-controller.js";
import { SttStreamCoordinator } from "./stt-stream.js";

const FRAME = 800;
const loud = () => {
  const b = Buffer.alloc(FRAME * 2);
  for (let i = 0; i < FRAME; i++) b.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
  return b;
};
const quiet = () => Buffer.alloc(FRAME * 2);
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeSession implements SttStreamingSession {
  ops: string[] = [];
  audioBytes = 0;
  open = true;
  cancelled = false;
  constructor(
    readonly handlers: SttStreamHandlers,
    readonly opts: SttStreamOptions,
  ) {}
  sendAudio(pcm: Buffer) {
    if (!this.open) return false;
    this.audioBytes += pcm.length;
    this.ops.push(`audio:${pcm.length}`);
    return true;
  }
  startUtterance() {
    this.ops.push("start");
    return this.open;
  }
  endUtterance() {
    this.ops.push("end");
    return this.open;
  }
  async close() {
    this.cancel();
  }
  cancel() {
    if (!this.open) return;
    this.open = false;
    this.cancelled = true;
    this.handlers.onClose();
  }
  partial(text: string, utteranceIdx?: number) {
    this.handlers.onPartial({ text, utteranceIdx });
  }
  final(text: string, utteranceIdx?: number, languageCode?: string) {
    this.handlers.onFinal({ text, utteranceIdx, languageCode });
  }
  fail(err: ProviderRequestError) {
    if (!this.open) return;
    this.open = false;
    this.handlers.onError(err);
    this.handlers.onClose();
  }
}

class FakeStt implements ISpeechToText {
  readonly name = "fake-stt";
  readonly capabilities = { streamingStt: true };
  sessions: FakeSession[] = [];
  /** When set, startStreaming never resolves (the connection is still being made). */
  hang = false;
  async transcribe(): Promise<never> {
    throw new Error("batch transcribe must not be used when streaming");
  }
  startStreaming = (handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession> => {
    const s = new FakeSession(handlers, opts);
    this.sessions.push(s);
    if (this.hang) return new Promise(() => undefined);
    return Promise.resolve(s);
  };
}

const netError = () => new ProviderRequestError("fake-stt", "fake stream dropped", undefined, { category: "network", operation: "stt.stream" });

function rig(opts: { languageCode?: string; maxQueuedBytes?: number; finalTimeoutMs?: number; maxPending?: number; stt?: FakeStt } = {}) {
  const clock = { t: 1_000 };
  const stt = opts.stt ?? new FakeStt();
  const call = new AbortController();
  const llm: string[] = [];
  const finished: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const log = {
    info: (m: string, f?: Record<string, unknown>) => {
      logs.push(m);
      if (m === "turn: finished") finished.push(f ?? {});
    },
    warn: (m: string) => void logs.push(m),
  };
  const ids = { callId: "call-12345678", agentId: "agent-1", organizationId: "org-1" };
  const coord = new SttStreamCoordinator({
    stt,
    ids,
    sampleRate: 8000,
    languageCode: opts.languageCode,
    minSpeechMs: 200,
    finalTimeoutMs: opts.finalTimeoutMs ?? 10_000,
    maxQueuedBytes: opts.maxQueuedBytes ?? 256 * 1024,
    callSignal: call.signal,
    now: () => clock.t,
    log,
  });
  const ctl = new TurnController({
    ids,
    vad: new TurnDetector({ sampleRate: 8000, energyThreshold: 500, minSpeechMs: 200, endSilenceMs: 300, maxUtteranceMs: 15000, preRollMs: 200 }),
    callSignal: call.signal,
    now: () => clock.t,
    log,
    maxPendingUtterances: opts.maxPending ?? 2,
    onVadEvent: coord.onVadEvent,
    onUtteranceDropped: coord.drop,
    onVadReset: coord.onVadReset,
    runUserTurn: async (_pcm, turn) => {
      const f = await coord.awaitFinal(turn.utteranceRef, turn.signal, turn.metrics);
      if (!f.text) return; // what the handler does with an empty transcript
      llm.push(f.text); // <- the hand-off to ConversationSession / LLM
    },
  });
  const speak = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 100;
      ctl.pushAudio(loud());
    }
  };
  const hush = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 100;
      ctl.pushAudio(quiet());
    }
  };
  return { clock, stt, call, llm, finished, logs, coord, ctl, speak, hush, say: (n = 4) => (speak(n), hush(3)) };
}

describe("streaming STT: session lifecycle and audio forwarding", () => {
  it("opens no session for silence or a noise blip (nothing noisy reaches the provider)", async () => {
    const r = rig();
    r.hush(10);
    r.speak(1);
    r.hush(4);
    await tick();
    expect(r.stt.sessions.length).toBe(0);
    expect(r.coord.stats.utterancesSent).toBe(0);
  });

  it("creates the session on the first real utterance and passes the language and identifiers", async () => {
    const r = rig({ languageCode: "ta-IN", maxQueuedBytes: 4096 });
    r.say();
    await tick();
    expect(r.stt.sessions.length).toBe(1);
    expect(r.stt.sessions[0].opts).toMatchObject({
      languageCode: "ta-IN",
      sampleRate: 8000,
      callId: "call-12345678",
      agentId: "agent-1",
      organizationId: "org-1",
      maxQueuedBytes: 4096,
    });
    expect(r.stt.sessions[0].opts.signal).toBe(r.call.signal);
  });

  it("no language configured -> no hint (the provider decides)", async () => {
    const r = rig();
    r.say();
    await tick();
    expect(r.stt.sessions[0].opts.languageCode).toBeUndefined();
  });

  it("forwards the utterance incrementally: start, pre-roll + speech frames as they arrive, then end", async () => {
    const r = rig();
    r.hush(2); // pre-roll
    r.speak(1);
    await tick();
    expect(r.stt.sessions.length).toBe(0); // 100 ms of speech: still held back
    r.speak(1); // 200 ms: confirmed
    await tick();
    const s = r.stt.sessions[0];
    expect(s.ops.slice(0, 3)).toEqual(["start", `audio:${3 * FRAME * 2}`, `audio:${FRAME * 2}`]); // pre-roll+frame, then frame
    const before = s.ops.length;
    r.speak(2);
    expect(s.ops.length).toBe(before + 2); // each further frame goes out as it arrives, not at the end
    expect(s.ops.at(-1)).not.toBe("end");
    r.hush(3);
    expect(s.ops.at(-1)).toBe("end");
    expect(s.ops.filter((o) => o === "end").length).toBe(1);
    expect(s.audioBytes).toBe((2 + 4 + 3) * FRAME * 2); // pre-roll + speech + trailing silence, exactly what the VAD kept
  });

  it("reuses one session across utterances", async () => {
    const r = rig();
    r.say();
    await tick();
    r.stt.sessions[0].final("one", 0);
    await tick();
    r.say();
    await tick();
    expect(r.stt.sessions.length).toBe(1);
    expect(r.stt.sessions[0].ops.filter((o) => o === "start").length).toBe(2);
  });
});

describe("streaming STT: partial and final transcripts", () => {
  it("a partial never reaches the LLM; the final does, exactly once", async () => {
    const r = rig();
    r.say();
    await tick();
    const s = r.stt.sessions[0];
    s.partial("can you", 0);
    s.partial("can you tell me", 0);
    await tick();
    expect(r.llm).toEqual([]);
    expect(r.ctl.state).toBe("PROCESSING");
    s.final("Can you tell me the price?", 0);
    await tick();
    expect(r.llm).toEqual(["Can you tell me the price?"]);
    expect(r.ctl.state).toBe("IDLE");
    expect(r.finished[0]).toMatchObject({ outcome: "completed", sttPartials: 2 });
  });

  it.each([
    ["English", "Can you tell me the price for a two bedroom apartment?", "en-IN"],
    ["Tamil", "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?", "ta-IN"],
    ["Tanglish", "Indha project la 2 BHK price evlo?", "ta-IN"],
  ])("%s transcripts pass through unmodified (no language-specific handling in the pipeline)", async (_n, text, lang) => {
    const r = rig({ languageCode: lang });
    r.say();
    await tick();
    r.stt.sessions[0].final(text, 0, lang);
    await tick();
    expect(r.llm).toEqual([text]);
  });

  it("ignores a repeated final (same provider utterance index), including while the next utterance waits", async () => {
    const r = rig();
    r.say();
    await tick();
    const s = r.stt.sessions[0];
    s.final("first", 0);
    await tick();
    s.final("first", 0); // duplicate delivery
    r.say();
    await tick();
    s.final("first", 0); // and again, with the next utterance now waiting: must NOT resolve it
    await tick();
    expect(r.llm).toEqual(["first"]);
    expect(r.coord.stats.duplicateFinals).toBe(2);
    s.final("second", 1);
    await tick();
    expect(r.llm).toEqual(["first", "second"]);
  });

  it("a final for an utterance that has not ended is ignored, not applied to a later one", async () => {
    const r = rig();
    r.speak(4); // still talking
    await tick();
    const s = r.stt.sessions[0];
    s.final("premature", 0);
    expect(r.coord.stats.unexpectedFinals).toBe(1);
    r.hush(3);
    await tick();
    expect(r.llm).toEqual([]);
    s.final("real", 1);
    await tick();
    expect(r.llm).toEqual(["real"]);
  });

  it("an empty final starts no LLM turn and is counted", async () => {
    const r = rig();
    r.say();
    await tick();
    r.stt.sessions[0].final("   ", 0);
    await tick();
    expect(r.llm).toEqual([]);
    expect(r.coord.stats).toMatchObject({ finals: 1, emptyFinals: 1 });
    expect(r.finished[0]).toMatchObject({ outcome: "completed", sttEmpty: true });
    expect(r.ctl.state).toBe("IDLE");
  });

  it("records STT latencies: speech start -> first partial, speech end -> final, total STT turn", async () => {
    const r = rig();
    r.speak(4); // speech frames land at t=1100..1400
    await tick();
    r.stt.sessions[0].partial("hel", 0); // at t=1400
    r.hush(3); // speech ends: 1700 - 300 = 1400
    await tick();
    r.clock.t = 1_900;
    r.stt.sessions[0].final("hello", 0);
    await tick();
    expect(r.finished[0]).toMatchObject({
      speechStartToFirstPartialMs: 300,
      speechEndToFinalMs: 500,
      sttTurnMs: 800,
      speechEndToSttEndMs: 500,
      sttPartials: 1,
      sttSessionToFinalMs: 700, // the session opens when speech is confirmed (200 ms in, t=1200) and the final lands at 1900
    });
  });
});

describe("streaming STT: cancellation", () => {
  it("a cancelled turn stops waiting; its late final is consumed and discarded, and the next turn gets ITS OWN final", async () => {
    const r = rig();
    r.say();
    await tick();
    const s = r.stt.sessions[0];
    r.ctl.cancelCurrent("test");
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "cancelled" });
    s.final("late answer to the cancelled turn", 0);
    await tick();
    expect(r.llm).toEqual([]);
    r.say();
    await tick();
    s.final("answer two", 1);
    await tick();
    expect(r.llm).toEqual(["answer two"]);
    expect(s.cancelled).toBe(false); // the session itself survives a cancelled turn
  });

  it("call end cancels the session, fails the waiting turn as cancelled and ignores everything afterwards", async () => {
    const r = rig();
    r.say();
    await tick();
    const s = r.stt.sessions[0];
    r.call.abort();
    await tick();
    expect(s.cancelled).toBe(true);
    expect(s.open).toBe(false);
    expect(r.finished[0]).toMatchObject({ outcome: "cancelled" });
    expect(r.llm).toEqual([]);
    r.say(); // controller is closed too; nothing new opens
    await tick();
    expect(r.stt.sessions.length).toBe(1);
    expect(() => r.coord.close()).not.toThrow(); // idempotent
    expect(r.logs).toContain("stt stream: call summary");
  });

  it("close() while the caller is mid-utterance releases the held audio and cancels", async () => {
    const r = rig();
    r.speak(1); // held, not yet sent
    r.coord.close();
    r.speak(5);
    await tick();
    expect(r.stt.sessions.length).toBe(0);
  });

  it("an utterance the VAD abandons mid-way (agent started speaking) is closed off so replies stay in step", async () => {
    const r = rig();
    r.speak(4);
    await tick();
    const s = r.stt.sessions[0];
    r.coord.onVadReset();
    expect(s.ops.at(-1)).toBe("end");
    s.final("orphan words", 0); // consumed, nobody waits
    await tick();
    expect(r.llm).toEqual([]);
    r.ctl.close();
  });

  it("an utterance dropped by the controller's queue limit has its final consumed, keeping later turns aligned", async () => {
    const r = rig({ maxPending: 1 });
    r.say(); // utterance 1 -> turn waiting for its final
    await tick();
    r.say(); // utterance 2 queued
    r.say(); // utterance 3 queued; utterance 2 is dropped by the controller
    await tick();
    expect(r.ctl.stats.droppedUtterances).toBe(1);
    const s = r.stt.sessions[0];
    s.final("one", 0);
    await tick();
    s.final("two (dropped)", 1);
    s.final("three", 2);
    await tick();
    expect(r.llm).toEqual(["one", "three"]);
  });
});

describe("streaming STT: provider failures", () => {
  it("a disconnect fails the turn safely, replays nothing, and the next utterance opens a fresh session", async () => {
    const r = rig();
    r.say();
    await tick();
    const first = r.stt.sessions[0];
    first.fail(netError());
    await tick();
    expect(r.llm).toEqual([]);
    expect(r.finished[0]).toMatchObject({ outcome: "error", errorName: "ProviderRequestError" });
    expect(r.logs).toContain("turn: failed");
    expect(r.coord.stats.errors).toBe(1);
    expect(r.ctl.state).toBe("IDLE");

    r.say();
    await tick();
    expect(r.stt.sessions.length).toBe(2);
    const second = r.stt.sessions[1];
    expect(second.ops[0]).toBe("start");
    expect(second.audioBytes).toBe(first.audioBytes); // exactly the new utterance's audio, not the old one's
    second.final("recovered", 0);
    await tick();
    expect(r.llm).toEqual(["recovered"]);
  });

  it("a session that closes without error while an answer is owed fails the turn", async () => {
    const r = rig();
    r.say();
    await tick();
    r.stt.sessions[0].cancel(); // provider hung up
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "error" });
  });

  it("an idle session that closed between utterances is not an error and is simply re-opened", async () => {
    const r = rig();
    r.say();
    await tick();
    r.stt.sessions[0].final("one", 0);
    await tick();
    r.stt.sessions[0].cancel(); // idle timeout between utterances
    await tick();
    expect(r.coord.stats.errors).toBe(0);
    r.say();
    await tick();
    expect(r.stt.sessions.length).toBe(2);
    r.stt.sessions[1].final("two", 0);
    await tick();
    expect(r.llm).toEqual(["one", "two"]);
  });

  it("a final that never arrives times out the turn AND cancels the session (a late final could mis-attribute)", async () => {
    const r = rig({ finalTimeoutMs: 40 });
    r.say();
    await tick();
    await wait(120);
    expect(r.finished[0]).toMatchObject({ outcome: "error" });
    expect(r.stt.sessions[0].cancelled).toBe(true);
    expect(r.coord.stats.timeouts).toBe(1);
    r.say();
    await tick();
    expect(r.stt.sessions.length).toBe(2);
  });

  it("audio queued while the connection is still being made is bounded: over the cap the turn fails instead of buffering", async () => {
    const stt = new FakeStt();
    stt.hang = true;
    const r = rig({ stt, maxQueuedBytes: 3_000 });
    r.say(6);
    await tick();
    expect(r.coord.stats.errors).toBe(1);
    expect(r.finished[0]).toMatchObject({ outcome: "error" });
    expect(stt.sessions[0].audioBytes).toBe(0);
  });

  it("a provider that cannot open a stream fails the turn without taking the call down", async () => {
    const stt = new FakeStt();
    stt.startStreaming = () => Promise.reject(new ProviderRequestError("fake-stt", "refused", undefined, { category: "auth", operation: "stt.stream" }));
    const r = rig({ stt });
    r.say();
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "error" });
    expect(r.ctl.state).toBe("IDLE");
  });
});

describe("streaming STT: many calls at once", () => {
  it("each call has its own session and gets only its own transcripts", async () => {
    const rigs = Array.from({ length: 12 }, () => rig());
    rigs.forEach((r) => r.say());
    await tick();
    expect(rigs.every((r) => r.stt.sessions.length === 1)).toBe(true);
    // Answer in reverse order, with a duplicate thrown in for good measure.
    [...rigs].reverse().forEach((r, i) => {
      const n = rigs.length - 1 - i;
      r.stt.sessions[0].final(`call-${n}`, 0);
      r.stt.sessions[0].final(`call-${n}`, 0);
    });
    await tick();
    rigs.forEach((r, n) => expect(r.llm).toEqual([`call-${n}`]));
    rigs[0].call.abort();
    await tick();
    expect(rigs[0].stt.sessions[0].cancelled).toBe(true);
    expect(rigs.slice(1).every((r) => !r.stt.sessions[0].cancelled)).toBe(true);
  });
});
