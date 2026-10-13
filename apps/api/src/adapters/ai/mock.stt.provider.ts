/**
 * Mock STT — for local dev/tests without Sarvam credentials. Never
 * claims to have transcribed anything real.
 *
 * Two modes:
 *  - Audio produced by `encodeMockSpeech()` (the local call simulator's
 *    "customer voice") is decoded back to the exact scripted utterance,
 *    so a multi-turn simulated call is fully deterministic. The marker may
 *    sit anywhere in the buffer, so it survives being wrapped in a WAV
 *    header or preceded by pre-roll silence.
 *  - Any other audio returns a clearly-labeled canned transcript.
 */
import type { ISpeechToText, SttResult, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "./stt.interface.js";
import { ProviderRequestError } from "../../shared/errors.js";

const MOCK_SPEECH_MAGIC = Buffer.from("MOCKSPEECH1:", "utf8");
/** The simulator sends 100 ms frames of 8 kHz 16-bit PCM = 1600 bytes. */
const FRAME_BYTES = 1600;
/** Long enough to count as real speech for the turn detector (400 ms at 8 kHz). */
const MIN_ENCODED_BYTES = FRAME_BYTES * 4;

/**
 * Encodes a scripted customer utterance as fake "speech" PCM for MockSttProvider.
 * The bytes are printable ASCII, which read as loud 16-bit samples, so the
 * energy-based turn detector treats them as speech. Padded to whole frames.
 */
export function encodeMockSpeech(text: string): Buffer {
  const body = Buffer.concat([MOCK_SPEECH_MAGIC, Buffer.from(text, "utf8"), Buffer.from([0])]);
  const size = Math.max(MIN_ENCODED_BYTES, Math.ceil(body.length / FRAME_BYTES) * FRAME_BYTES);
  const out = Buffer.alloc(size, 0x20); // 0x20 = loud padding after the NUL terminator
  body.copy(out);
  return out;
}

function decodeMockSpeech(audio: Buffer): string | null {
  const start = audio.indexOf(MOCK_SPEECH_MAGIC);
  if (start < 0) return null;
  const textStart = start + MOCK_SPEECH_MAGIC.length;
  const end = audio.indexOf(0, textStart);
  return audio.toString("utf8", textStart, end < 0 ? audio.length : end).trim();
}

/**
 * Deterministic streaming session: audio is collected between startUtterance() and endUtterance(); at the end it emits
 * one partial (the first words) and then exactly one final, asynchronously, like a real provider. It honours the
 * queue bound and cancel() so pipeline tests exercise the same lifecycle as the real adapter.
 */
class MockSttStreamingSession implements SttStreamingSession {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private isOpen = true;
  private idx = 0;

  constructor(
    private readonly handlers: SttStreamHandlers,
    private readonly opts: SttStreamOptions,
  ) {}

  get open() {
    return this.isOpen;
  }

  sendAudio(pcm: Buffer): boolean {
    if (!this.isOpen) return false;
    this.bytes += pcm.length;
    if (this.bytes > (this.opts.maxQueuedBytes ?? Infinity)) {
      this.finish(new ProviderRequestError("mock-stt", "mock-stt stt.stream: audio queue limit reached", undefined, { category: "internal", operation: "stt.stream" }));
      return false;
    }
    this.chunks.push(pcm);
    return true;
  }

  startUtterance(): boolean {
    if (!this.isOpen) return false;
    this.chunks = [];
    this.bytes = 0;
    return true;
  }

  endUtterance(): boolean {
    if (!this.isOpen) return false;
    const audio = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    const text = decodeMockSpeech(audio) ?? "[mock transcription] Hi, I am interested in a 2 BHK.";
    const utteranceIdx = this.idx++;
    setImmediate(() => {
      if (!this.isOpen) return;
      const firstWords = text.split(/\s+/).slice(0, 2).join(" ");
      this.handlers.onPartial({ text: firstWords, utteranceIdx, languageCode: "en-IN" });
      this.handlers.onFinal({ text, utteranceIdx, languageCode: "en-IN" });
    });
    return true;
  }

  async close(): Promise<void> {
    this.finish();
  }

  cancel(): void {
    this.finish();
  }

  private finish(error?: ProviderRequestError) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.chunks = [];
    if (error) this.handlers.onError(error);
    this.handlers.onClose();
  }
}

export class MockSttProvider implements ISpeechToText {
  readonly name = "mock-stt";
  readonly capabilities = { streamingStt: true };

  async startStreaming(handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession> {
    const session = new MockSttStreamingSession(handlers, opts);
    opts.signal?.addEventListener("abort", () => session.cancel(), { once: true });
    return session;
  }

  async transcribe(audio: Buffer): Promise<SttResult> {
    const scripted = decodeMockSpeech(audio);
    if (scripted !== null) return { text: scripted, languageCode: "en-IN" };
    return { text: "[mock transcription] Hi, I am interested in a 2 BHK.", languageCode: "en-IN" };
  }
}
