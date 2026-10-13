/**
 * Reliability wrapper for STREAMING TTS: circuit breaker, stall timeout, cancellation, and the rule that a stream is
 * never retried (only the caller may repeat one, and only when nothing was heard). Stub provider, no sockets.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ReliableTextToSpeech } from "./reliable-providers.js";
import { MockTtsProvider } from "./mock.tts.provider.js";
import { CircuitOpenError, ProviderRequestError, type ProviderFailureCategory } from "../../shared/errors.js";
import type { ITextToSpeech, TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions } from "./tts.interface.js";

const uniq = () => `stub-tts-${Math.random().toString(36).slice(2)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENV = ["PROVIDER_TTS_TIMEOUT_MS", "PROVIDER_BREAKER_FAILURE_THRESHOLD", "PROVIDER_MAX_ATTEMPTS"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

class Stub implements ITextToSpeech {
  readonly name = uniq();
  readonly capabilities = { streamingTts: true };
  opened = 0;
  handlers!: TtsStreamHandlers;
  cancelled = false;
  texts: string[] = [];
  async synthesize(): Promise<never> {
    throw new Error("batch not used");
  }
  async startStreaming(handlers: TtsStreamHandlers, _opts: TtsStreamOptions): Promise<TtsStreamingSession> {
    this.opened++;
    this.handlers = handlers;
    let open = true;
    return {
      get open() {
        return open;
      },
      sendText: (t) => {
        this.texts.push(t);
        return true;
      },
      cancel: () => {
        if (!open) return;
        open = false;
        this.cancelled = true;
        handlers.onClose();
      },
      close: async () => {
        open = false;
        handlers.onClose();
      },
    };
  }
}
const sink = () => {
  const ev: string[] = [];
  const errors: ProviderRequestError[] = [];
  const handlers: TtsStreamHandlers = {
    onAudio: () => void ev.push("audio"),
    onSegmentComplete: () => void ev.push("done"),
    onError: (e) => {
      ev.push("error");
      errors.push(e as ProviderRequestError);
    },
    onClose: () => void ev.push("close"),
  };
  return { ev, errors, handlers };
};
const perr = (c: ProviderFailureCategory) => new ProviderRequestError("stub", `stub ${c}`, undefined, { category: c, operation: "tts.stream" });

describe("ReliableTextToSpeech streaming", () => {
  it("streams only when the wrapped provider can; the mock and Sarvam can, a batch-only provider cannot", () => {
    expect(new ReliableTextToSpeech(new MockTtsProvider()).startStreaming).toBeTypeOf("function");
    expect(new ReliableTextToSpeech({ name: "batch-only", synthesize: async () => ({ audio: Buffer.alloc(0), format: "wav" as const }) }).startStreaming).toBeUndefined();
  });

  it("passes events through in order and never retries: one open per call, even after a transient error", async () => {
    process.env.PROVIDER_MAX_ATTEMPTS = "3";
    const inner = new Stub();
    const w = new ReliableTextToSpeech(inner);
    const k = sink();
    const s = await w.startStreaming!(k.handlers, { sampleRate: 8000 });
    s.sendText("Hello.");
    inner.handlers.onAudio(Buffer.alloc(2));
    inner.handlers.onSegmentComplete();
    inner.handlers.onError(perr("server"));
    expect(k.ev).toEqual(["audio", "done", "error"]);
    expect(inner.opened).toBe(1);
  });

  it("circuit breaker: repeated provider failures open it, then a stream is refused WITHOUT touching the provider", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    const inner = new Stub();
    const w = new ReliableTextToSpeech(inner);
    for (let i = 0; i < 2; i++) {
      await w.startStreaming!(sink().handlers, { sampleRate: 8000 });
      inner.handlers.onError(perr("server"));
      await wait(2);
    }
    const before = inner.opened;
    await expect(w.startStreaming!(sink().handlers, { sampleRate: 8000 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.opened).toBe(before);
  });

  it("failures that are not a health signal (invalid voice, auth, cancellation) never open the breaker", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    const inner = new Stub();
    const w = new ReliableTextToSpeech(inner);
    for (const c of ["invalid_request", "invalid_request", "invalid_request", "auth"] as const) {
      await w.startStreaming!(sink().handlers, { sampleRate: 8000 });
      inner.handlers.onError(perr(c));
      await wait(2);
    }
    await expect(w.startStreaming!(sink().handlers, { sampleRate: 8000 })).resolves.toBeDefined();
  });

  it("a stall (text outstanding, no audio / completion) fails with a timeout, cancels the provider and counts toward the breaker", async () => {
    process.env.PROVIDER_TTS_TIMEOUT_MS = "40";
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "1";
    const inner = new Stub();
    const w = new ReliableTextToSpeech(inner);
    const k = sink();
    const s = await w.startStreaming!(k.handlers, { sampleRate: 8000 });
    s.sendText("Hello.");
    await wait(90);
    expect(k.errors).toHaveLength(1);
    expect(k.errors[0].category).toBe("timeout");
    expect(inner.cancelled).toBe(true);
    expect(k.ev.filter((e) => e === "close")).toHaveLength(1);
    expect(s.open).toBe(false);
    inner.handlers.onAudio(Buffer.alloc(2)); // a straggler is ignored
    expect(k.ev).not.toContain("audio");
    expect(s.sendText("more")).toBe(false);
    await wait(2);
    await expect(w.startStreaming!(sink().handlers, { sampleRate: 8000 })).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("steady progress keeps the stall timer from firing; an idle session (nothing outstanding) has no timer at all", async () => {
    process.env.PROVIDER_TTS_TIMEOUT_MS = "60";
    const inner = new Stub();
    const k = sink();
    const s = await new ReliableTextToSpeech(inner).startStreaming!(k.handlers, { sampleRate: 8000 });
    await wait(100); // idle: the LLM may take its time between sentences
    s.sendText("Long reply.");
    for (let i = 0; i < 4; i++) {
      await wait(35);
      inner.handlers.onAudio(Buffer.alloc(2));
    }
    inner.handlers.onSegmentComplete();
    await wait(100);
    expect(k.errors).toEqual([]);
    expect(inner.cancelled).toBe(false);
    await s.close();
  });

  it("cancel() stops the stall timer and cancels the provider", async () => {
    process.env.PROVIDER_TTS_TIMEOUT_MS = "40";
    const inner = new Stub();
    const k = sink();
    const s = await new ReliableTextToSpeech(inner).startStreaming!(k.handlers, { sampleRate: 8000 });
    s.sendText("Hello.");
    s.cancel();
    await wait(80);
    expect(k.errors).toEqual([]); // cancelled is not a timeout
    expect(inner.cancelled).toBe(true);
  });

  it("a provider that fails to open releases the breaker slot and rethrows", async () => {
    const inner = new Stub();
    inner.startStreaming = async () => {
      throw perr("network");
    };
    const w = new ReliableTextToSpeech(inner);
    await expect(w.startStreaming!(sink().handlers, { sampleRate: 8000 })).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
