/**
 * The streaming side of the STT provider layer that is not Sarvam-protocol specific: the Mock provider's streaming
 * session, the reliability wrapper (circuit breaker, no retries), and proof that the batch path is untouched.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { MockSttProvider, encodeMockSpeech } from "./mock.stt.provider.js";
import { ReliableSpeechToText } from "./reliable-providers.js";
import { getSttProvider, setSttProvider } from "./index.js";
import { pcm16ToWav } from "../../audio/pcm.js";
import { CircuitOpenError, ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import type { ISpeechToText, SttStreamHandlers, SttStreamingSession, SttStreamOptions, SttTranscriptEvent } from "./stt.interface.js";

const tick = () => new Promise((r) => setImmediate(r));

function handlers() {
  const partials: SttTranscriptEvent[] = [];
  const finals: SttTranscriptEvent[] = [];
  const errors: ProviderRequestError[] = [];
  let closes = 0;
  const h: SttStreamHandlers = {
    onPartial: (e) => void partials.push(e),
    onFinal: (e) => void finals.push(e),
    onError: (e) => void errors.push(e as ProviderRequestError),
    onClose: () => void closes++,
  };
  return { h, partials, finals, errors, closes: () => closes };
}

afterEach(() => {
  setSttProvider(null);
  delete process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD;
  vi.restoreAllMocks();
});

describe("Mock STT streaming (deterministic stand-in used by tests and the simulator)", () => {
  it("advertises streaming and turns one delimited utterance into one partial and one final", async () => {
    const p = new MockSttProvider();
    expect(p.capabilities.streamingStt).toBe(true);
    const x = handlers();
    const s = await p.startStreaming(x.h, { sampleRate: 8000 });
    s.startUtterance();
    const speech = encodeMockSpeech("I'm looking for a 2 BHK.");
    for (let i = 0; i < speech.length; i += 1600) s.sendAudio(speech.subarray(i, i + 1600));
    s.endUtterance();
    await tick();
    expect(x.partials.map((e) => e.text)).toEqual(["I'm looking"]);
    expect(x.finals).toEqual([{ text: "I'm looking for a 2 BHK.", utteranceIdx: 0, languageCode: "en-IN" }]);
    s.startUtterance();
    s.sendAudio(encodeMockSpeech("Second one."));
    s.endUtterance();
    await tick();
    expect(x.finals.map((e) => [e.text, e.utteranceIdx])).toEqual([
      ["I'm looking for a 2 BHK.", 0],
      ["Second one.", 1],
    ]);
  });

  it("cancel() is silent apart from onClose, and the batch path still works", async () => {
    const p = new MockSttProvider();
    const x = handlers();
    const s = await p.startStreaming(x.h, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(encodeMockSpeech("never delivered"));
    s.endUtterance();
    s.cancel();
    await tick();
    expect(x.finals).toEqual([]);
    expect(x.closes()).toBe(1);
    expect(s.open).toBe(false);
    expect(s.sendAudio(Buffer.alloc(10))).toBe(false);
    // existing batch behaviour is unchanged
    expect((await p.transcribe(pcm16ToWav(encodeMockSpeech("Hello there."), 8000))).text).toBe("Hello there.");
  });

  it("honours the queue bound and the abort signal", async () => {
    const p = new MockSttProvider();
    const x = handlers();
    const s = await p.startStreaming(x.h, { sampleRate: 8000, maxQueuedBytes: 1000 });
    expect(s.sendAudio(Buffer.alloc(2000))).toBe(false);
    expect(x.errors.length).toBe(1);

    const ac = new AbortController();
    const y = handlers();
    const s2 = await p.startStreaming(y.h, { sampleRate: 8000, signal: ac.signal });
    ac.abort();
    expect(s2.open).toBe(false);
    expect(y.closes()).toBe(1);
  });

  it("the configured provider (AI_PROVIDER=mock) exposes streaming through the reliability wrapper", async () => {
    const p = getSttProvider();
    expect(p.capabilities?.streamingStt).toBe(true);
    expect(typeof p.startStreaming).toBe("function");
    const x = handlers();
    const s = await p.startStreaming!(x.h, { sampleRate: 8000 });
    s.startUtterance();
    s.sendAudio(encodeMockSpeech("through the wrapper"));
    s.endUtterance();
    await tick();
    expect(x.finals[0].text).toBe("through the wrapper");
    s.cancel();
  });
});

describe("ReliableSpeechToText with streaming", () => {
  class Inner implements ISpeechToText {
    capabilities = { streamingStt: true };
    last?: { h: SttStreamHandlers; session: StubSession };
    constructor(readonly name: string) {}
    async transcribe() {
      return { text: "batch" };
    }
    startStreaming = async (h: SttStreamHandlers): Promise<SttStreamingSession> => {
      const session = new StubSession(h);
      this.last = { h, session };
      return session;
    };
  }
  class StubSession implements SttStreamingSession {
    open = true;
    calls = 0;
    constructor(readonly h: SttStreamHandlers) {}
    sendAudio() {
      this.calls++;
      return true;
    }
    startUtterance() {
      return true;
    }
    endUtterance() {
      return true;
    }
    async close() {}
    cancel() {
      this.open = false;
      this.h.onClose();
    }
  }
  const uniq = () => `stub-stt-${Math.random().toString(36).slice(2)}`;
  const fail = (category: "network" | "auth") => new ProviderRequestError("x", "fail", undefined, { category, operation: "stt.stream" });

  it("is only streaming-capable when the wrapped provider is (batch-only providers are untouched)", () => {
    const batchOnly: ISpeechToText = { name: uniq(), transcribe: async () => ({ text: "x" }) };
    expect(new ReliableSpeechToText(batchOnly).startStreaming).toBeUndefined();
    expect(new ReliableSpeechToText(new Inner(uniq())).startStreaming).toBeDefined();
  });

  it("passes events through unchanged and does not retry or replay on failure", async () => {
    const inner = new Inner(uniq());
    const w = new ReliableSpeechToText(inner);
    const x = handlers();
    let starts = 0;
    const original = inner.startStreaming;
    inner.startStreaming = (h) => (starts++, original(h));
    const w2 = new ReliableSpeechToText(inner);
    const s = await w2.startStreaming!(x.h, { sampleRate: 8000 });
    inner.last!.h.onFinal({ text: "hello", utteranceIdx: 0 });
    inner.last!.h.onError(fail("network"));
    expect(x.finals.map((f) => f.text)).toEqual(["hello"]);
    expect(x.errors.length).toBe(1);
    expect(starts).toBe(1); // a failed stream is not re-opened behind the caller's back
    void w;
    s.cancel();
  });

  it("repeated stream failures open the circuit; further streams fail fast and nothing is opened", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inner = new Inner(uniq());
    const w = new ReliableSpeechToText(inner);
    for (let i = 0; i < 2; i++) {
      const x = handlers();
      await w.startStreaming!(x.h, { sampleRate: 8000 });
      inner.last!.h.onError(fail("network"));
      await tick();
    }
    const before = inner.last;
    await expect(w.startStreaming!(handlers().h, { sampleRate: 8000 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.last).toBe(before); // the provider was not touched
  });

  it("auth failures and cancellations do not count against provider health", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    const inner = new Inner(uniq());
    const w = new ReliableSpeechToText(inner);
    for (let i = 0; i < 4; i++) {
      await w.startStreaming!(handlers().h, { sampleRate: 8000 });
      if (i % 2) inner.last!.h.onError(fail("auth"));
      else inner.last!.session.cancel();
      await tick();
    }
    await expect(w.startStreaming!(handlers().h, { sampleRate: 8000 })).resolves.toBeDefined();
  });

  it("a stream that delivers a transcript closes the half-open circuit (counts as success)", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    const inner = new Inner(uniq());
    const w = new ReliableSpeechToText(inner);
    await w.startStreaming!(handlers().h, { sampleRate: 8000 });
    inner.last!.h.onError(fail("network"));
    await tick();
    await w.startStreaming!(handlers().h, { sampleRate: 8000 });
    inner.last!.h.onPartial({ text: "ok" }); // success resets the failure streak
    await tick();
    await w.startStreaming!(handlers().h, { sampleRate: 8000 });
    inner.last!.h.onError(fail("network"));
    await tick();
    await expect(w.startStreaming!(handlers().h, { sampleRate: 8000 })).resolves.toBeDefined(); // 1 failure since success: still closed
  });

  it("a refusal known up front (missing credentials) rejects and still releases the breaker ticket", async () => {
    const inner = new Inner(uniq());
    inner.startStreaming = async () => {
      throw new ProviderConfigError("x", "no key");
    };
    const w = new ReliableSpeechToText(inner);
    for (let i = 0; i < 5; i++) await expect(w.startStreaming!(handlers().h, { sampleRate: 8000 } as SttStreamOptions)).rejects.toBeInstanceOf(ProviderConfigError);
  });
});
