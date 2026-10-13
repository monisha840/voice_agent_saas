/**
 * Mock TTS — returns a tiny valid (silent) WAV buffer so the pipeline's
 * "send audio back to telephony" step can be exercised without Sarvam
 * credentials. Does not claim to be real synthesized speech.
 */
import type { ITextToSpeech, TtsOptions, TtsResult, TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions } from "./tts.interface.js";
import { ProviderRequestError } from "../../shared/errors.js";
import type { ProviderCapabilities } from "./provider-common.js";

/** Minimal valid 8kHz mono 16-bit PCM WAV header + 0.5s of silence. */
function buildSilentWav(sampleRate: number): Buffer {
  const numSamples = Math.floor(sampleRate * 0.5);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Remaining bytes default to 0 (silence).

  return buffer;
}

export interface MockStreamingBehavior {
  /** PCM chunks produced per sentence, and the size of each (bytes, even). */
  chunksPerSegment?: number;
  chunkBytes?: number;
  /** Delay before each chunk (ms). 0 = next macrotask. */
  chunkDelayMs?: number;
  /** Voices the "provider" rejects (invalid_request), like an unknown Sarvam speaker. */
  invalidVoices?: string[];
  /** Fail the session with this category after `failAfterChunks` chunks have been delivered (0 = before any audio). */
  failWith?: "timeout" | "server" | "network" | "invalid_request";
  failAfterChunks?: number;
  /** Never produce anything (a stalled provider). */
  stall?: boolean;
}

/** A streaming session as the mock saw it, for tests. */
export interface MockStreamSession {
  voice?: string;
  languageCode?: string;
  sampleRate: number;
  texts: string[];
  cancelled: boolean;
  closed: boolean;
  /** Epoch ms at which each text arrived / each chunk was delivered. */
  textAt: number[];
  chunksDelivered: number;
}

export class MockTtsProvider implements ITextToSpeech {
  readonly name = "mock-tts";
  readonly capabilities: ProviderCapabilities = { voiceSelection: true, languageHint: true, streamingTts: true };
  /** Streaming sessions opened, newest last. */
  readonly streamSessions: MockStreamSession[] = [];
  /** Tests may change this between turns. */
  streaming: MockStreamingBehavior;

  constructor(streaming: MockStreamingBehavior = {}) {
    this.streaming = streaming;
  }

  /**
   * Deterministic streaming: each sentence yields `chunksPerSegment` silent PCM chunks, then its completion, in order.
   * Mirrors the real session contract (no delivery after cancel; exactly one onClose).
   */
  async startStreaming(handlers: TtsStreamHandlers, opts: TtsStreamOptions): Promise<TtsStreamingSession> {
    const b = this.streaming;
    const rec: MockStreamSession = { voice: opts.voice, languageCode: opts.languageCode, sampleRate: opts.sampleRate, texts: [], cancelled: false, closed: false, textAt: [], chunksDelivered: 0 };
    this.streamSessions.push(rec);
    if (this.streamSessions.length > 100) this.streamSessions.shift();
    let open = true;
    let chain: Promise<void> = Promise.resolve();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, ms);
        t.unref?.();
        timers.add(t);
      });
    const finish = () => {
      if (rec.closed) return;
      rec.closed = true;
      open = false;
      timers.forEach(clearTimeout);
      timers.clear();
      handlers.onClose();
    };
    const fail = (category: NonNullable<MockStreamingBehavior["failWith"]>) => {
      if (!open) return;
      handlers.onError(new ProviderRequestError("mock-tts", `mock-tts tts.stream failed (${category})`, undefined, { category, operation: "tts.stream" }));
      finish();
    };
    const session: TtsStreamingSession = {
      get open() {
        return open;
      },
      sendText: (text) => {
        if (!open) return false;
        rec.texts.push(text);
        rec.textAt.push(Date.now());
        const failing = b.failWith && (opts.voice === undefined || !b.invalidVoices?.includes(opts.voice));
        chain = chain.then(async () => {
          if (!open || b.stall) return;
          if (opts.voice && b.invalidVoices?.includes(opts.voice)) return fail("invalid_request");
          for (let i = 0; i < (b.chunksPerSegment ?? 1); i++) {
            await sleep(b.chunkDelayMs ?? 0);
            if (!open) return;
            if (failing && rec.chunksDelivered >= (b.failAfterChunks ?? 0)) return fail(b.failWith!);
            rec.chunksDelivered++;
            handlers.onAudio(Buffer.alloc(b.chunkBytes ?? 4000));
          }
          if (!open) return;
          handlers.onSegmentComplete();
        });
        return true;
      },
      cancel: () => {
        rec.cancelled = true;
        finish();
      },
      close: async () => {
        await chain;
        finish();
      },
    };
    opts.signal?.addEventListener("abort", () => session.cancel(), { once: true });
    return session;
  }

  /** The most recent requests (newest last), so tests can see what reached the provider, e.g. the voice. */
  readonly requests: Array<{ text: string; voice?: string; languageCode?: string }> = [];

  async synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
    this.requests.push({ text, voice: opts?.voice, languageCode: opts?.languageCode });
    if (this.requests.length > 100) this.requests.shift();
    return { audio: buildSilentWav(opts?.sampleRate ?? 8000), format: "wav" };
  }
}
