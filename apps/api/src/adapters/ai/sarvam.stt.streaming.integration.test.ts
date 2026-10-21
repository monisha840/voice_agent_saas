/**
 * OPT-IN integration test against the REAL Sarvam realtime STT endpoint. Skipped unless explicitly enabled:
 *
 *   SARVAM_STT_INTEGRATION=1 SARVAM_API_KEY=... pnpm --filter @voice-agent/api test sarvam.stt.streaming.integration
 *
 * It costs a little Sarvam usage. It synthesizes a short phrase with Sarvam TTS, streams that audio (as 8 kHz PCM, the
 * telephony format) through the realtime session using manual endpointing, and checks that a non-empty final comes
 * back. It deliberately does NOT assert exact wording or latency: it verifies the protocol works end to end, not
 * accuracy (accuracy needs real phone recordings).
 *
 * NOT part of the normal suite: the unit/contract tests never need credentials or internet.
 */
import { describe, it, expect } from "vitest";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import { ttsAudioToPcm } from "../../audio/pcm.js";
import type { SttTranscriptEvent } from "./stt.interface.js";

const enabled = process.env.SARVAM_STT_INTEGRATION === "1" && !!process.env.SARVAM_API_KEY;

describe.skipIf(!enabled)("Sarvam realtime STT (real API)", () => {
  it.each([
    ["English", "en-IN", "Can you tell me the price for a two bedroom apartment?"],
    ["Tamil", "ta-IN", "இந்த திட்டத்தில் இரண்டு படுக்கையறை வீட்டின் விலை எவ்வளவு?"],
  ])("%s: streams 8 kHz PCM and receives a non-empty final", async (_name, lang, phrase) => {
    const tts = await new SarvamTtsProvider().synthesize(phrase, { languageCode: lang, sampleRate: 8000 });
    const pcm = ttsAudioToPcm(tts.audio, tts.format, 8000);

    const partials: SttTranscriptEvent[] = [];
    const finals: SttTranscriptEvent[] = [];
    const errors: unknown[] = [];
    const session = await new SarvamSttProvider().startStreaming(
      { onPartial: (e) => void partials.push(e), onFinal: (e) => void finals.push(e), onError: (e) => void errors.push(e), onClose: () => undefined },
      { sampleRate: 8000, languageCode: lang },
    );
    session.startUtterance();
    for (let i = 0; i < pcm.length; i += 1600) {
      session.sendAudio(pcm.subarray(i, i + 1600));
      await new Promise((r) => setTimeout(r, 100)); // real-time pacing: 100 ms per 100 ms of audio
    }
    session.sendAudio(Buffer.alloc(8000 * 2 * 0.5)); // half a second of trailing silence
    session.endUtterance();

    const deadline = Date.now() + 15_000;
    while (finals.length === 0 && errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await session.close();

    expect(errors).toEqual([]);
    expect(finals.length).toBe(1);
    expect(finals[0].text.trim().length).toBeGreaterThan(0);
    console.log(`[integration] ${lang}: partials=${partials.length} final="${finals[0].text}"`);
  }, 40_000);
});
