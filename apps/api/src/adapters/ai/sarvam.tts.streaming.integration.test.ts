/**
 * OPT-IN integration test against the REAL Sarvam streaming TTS endpoint. Skipped unless explicitly enabled:
 *
 *   SARVAM_TTS_INTEGRATION=1 SARVAM_API_KEY=... npx vitest run sarvam.tts.streaming.integration
 *
 * It costs a little Sarvam usage. It sends two sentences, then checks the things the contract tests can only ASSUME:
 * audio arrives, a completion event arrives per sentence, the chunks are usable PCM at the requested rate (raw or
 * WAV-wrapped), and the time to first audio. It does NOT assert exact latency or audio quality.
 *
 * NOT part of the normal suite: the unit/contract tests never need credentials or internet.
 */
import { describe, it, expect } from "vitest";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";

const enabled = process.env.SARVAM_TTS_INTEGRATION === "1" && !!process.env.SARVAM_API_KEY;

describe.skipIf(!enabled)("Sarvam streaming TTS (real API)", () => {
  it("streams audio for two sentences and completes each one", async () => {
    const chunks: Buffer[] = [];
    let completed = 0;
    let firstAudioMs: number | undefined;
    const errors: unknown[] = [];
    const t0 = Date.now();
    const session = await new SarvamTtsProvider().startStreaming(
      {
        onAudio: (pcm) => {
          firstAudioMs ??= Date.now() - t0;
          chunks.push(pcm);
        },
        onSegmentComplete: () => void completed++,
        onError: (e) => void errors.push(e),
        onClose: () => undefined,
      },
      { sampleRate: 8000, languageCode: "en-IN" },
    );
    session.sendText("Hello Rajesh.");
    session.sendText("I can help you with the two bedroom options.");
    for (let i = 0; i < 300 && completed < 2 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    session.cancel();

    expect(errors).toEqual([]);
    expect(completed).toBe(2);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.length % 2).toBe(0);
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    console.info(`sarvam tts stream: first audio after ${firstAudioMs} ms, ${chunks.length} chunks, ${Math.round((bytes / 2 / 8000) * 1000)} ms of audio`);
    expect(bytes / 2 / 8000).toBeGreaterThan(1); // more than a second of speech for two sentences
  }, 30_000);
});
