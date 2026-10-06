/**
 * Mock TTS — returns a tiny valid (silent) WAV buffer so the pipeline's
 * "send audio back to telephony" step can be exercised without Sarvam
 * credentials. Does not claim to be real synthesized speech.
 */
import type { ITextToSpeech, TtsResult } from "./tts.interface.js";

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

export class MockTtsProvider implements ITextToSpeech {
  readonly name = "mock-tts";

  async synthesize(_text: string, opts?: { languageCode?: string; sampleRate?: number }): Promise<TtsResult> {
    return { audio: buildSilentWav(opts?.sampleRate ?? 8000), format: "wav" };
  }
}
