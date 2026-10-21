/**
 * EXPERIMENT — OPT-IN integration test against the REAL AssemblyAI streaming service. Skipped unless enabled:
 *
 *   ASSEMBLYAI_STT_INTEGRATION=1 ASSEMBLYAI_API_KEY=... pnpm --filter @voice-agent/api test assemblyai.stt.integration
 *
 * Audio comes from, in order: files in ASSEMBLYAI_STT_AUDIO_DIR (default ./bench-audio: english.wav,
 * indian-english.wav, and optionally phone-8k.wav, a real phone-quality recording), else Sarvam TTS when
 * SARVAM_API_KEY is set (synthetic speech). A test with no audio source is skipped, not faked.
 *
 * It verifies the PROTOCOL end to end (auth, model accepted, 8 kHz PCM accepted as is, partials, one final,
 * ForceEndpoint behaviour, cancellation) and prints the model, audio format and observed timings. Transcript text is
 * printed only with ASSEMBLYAI_INTEGRATION_SHOW_TEXT=1. It asserts no accuracy and no latency numbers. Tamil is not
 * tested: it is not a supported AssemblyAI streaming language. The API key is never printed.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AssemblyAiSttProvider } from "./assemblyai.stt.provider.js";
import { SarvamTtsProvider } from "../sarvam.tts.provider.js";
import { parseWav, resamplePcm16, ttsAudioToPcm } from "../../../audio/pcm.js";
import { getConfig } from "../../../config/env.js";

const enabled = process.env.ASSEMBLYAI_STT_INTEGRATION === "1" && !!process.env.ASSEMBLYAI_API_KEY;
const dir = resolve(process.env.ASSEMBLYAI_STT_AUDIO_DIR ?? "bench-audio");
const showText = process.env.ASSEMBLYAI_INTEGRATION_SHOW_TEXT === "1";
const FRAME = 1600; // 100 ms @ 8 kHz
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function audioFor(file: string, phrase: string): Promise<{ pcm: Buffer; source: string } | null> {
  const path = join(dir, file);
  if (existsSync(path)) {
    const wav = parseWav(readFileSync(path));
    if (wav) return { pcm: resamplePcm16(wav.pcm, wav.sampleRate, 8000), source: `file ${file}` };
  }
  if (process.env.SARVAM_API_KEY) {
    const tts = await new SarvamTtsProvider().synthesize(phrase, { languageCode: "en-IN", sampleRate: 8000 });
    return { pcm: ttsAudioToPcm(tts.audio, tts.format, 8000), source: "synthetic (Sarvam TTS)" };
  }
  return null;
}

async function stream(pcm: Buffer, opts: { cancelAfterPartials?: number } = {}) {
  const partials: number[] = [];
  const finals: string[] = [];
  const errors: string[] = [];
  let finalAt = 0;
  let closed = false;
  const t0 = Date.now();
  const session = await new AssemblyAiSttProvider().startStreaming(
    {
      onPartial: () => void partials.push(Date.now() - t0),
      onFinal: (e) => (finals.push(e.text), (finalAt ||= Date.now())),
      onError: (e) => void errors.push(`${e.name}:${(e as { category?: string }).category}`),
      onClose: () => void (closed = true),
    },
    { sampleRate: 8000, languageCode: "en-IN" },
  );
  session.startUtterance();
  for (let i = 0; i < pcm.length && session.open; i += FRAME) {
    session.sendAudio(pcm.subarray(i, i + FRAME));
    await sleep(100);
    if (opts.cancelAfterPartials && partials.length >= opts.cancelAfterPartials) {
      session.cancel();
      return { partials, finals, errors, finalMs: undefined, closed, cancelled: true };
    }
  }
  for (let i = 0; i < 7 && session.open; i++) {
    session.sendAudio(Buffer.alloc(FRAME));
    await sleep(100);
  }
  const speechEnd = Date.now();
  session.endUtterance();
  const deadline = Date.now() + 15_000;
  while (!finals.length && !errors.length && Date.now() < deadline) await sleep(20);
  session.cancel();
  return { partials, finals, errors, finalMs: finalAt ? finalAt - speechEnd : undefined, closed, cancelled: false };
}

describe.skipIf(!enabled)("AssemblyAI realtime STT (real service)", () => {
  it.each([
    ["English", "english.wav", "Hello, I am looking for a two bedroom apartment."],
    ["Indian English", "indian-english.wav", "Can you tell me the price and location of the project?"],
  ])("%s: streams 8 kHz PCM, receives partials and exactly one final", async (label, file, phrase) => {
    const a = await audioFor(file, phrase);
    if (!a) return console.log(`[assemblyai-integration] ${label}: no audio source (add ${file} or set SARVAM_API_KEY); skipped`);
    const r = await stream(a.pcm);
    console.log(
      `[assemblyai-integration] ${label}: model=${getConfig().assemblyai.model} audio=pcm_s16le/8000Hz/mono source=${a.source} ` +
        `firstPartial=${r.partials[0] ?? "-"}ms partials=${r.partials.length} finalAfterSpeechEnd=${r.finalMs ?? "-"}ms errors=${JSON.stringify(r.errors)}` +
        (showText ? ` text=${JSON.stringify(r.finals[0])}` : ""),
    );
    expect(r.errors).toEqual([]);
    expect(r.finals.length).toBe(1);
    expect(r.finals[0].trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("a real phone-quality 8 kHz recording (phone-8k.wav), if one is provided", async () => {
    const path = join(dir, "phone-8k.wav");
    if (!existsSync(path)) return console.log("[assemblyai-integration] no phone-8k.wav in the audio dir; skipped");
    const wav = parseWav(readFileSync(path))!;
    const r = await stream(resamplePcm16(wav.pcm, wav.sampleRate, 8000));
    console.log(`[assemblyai-integration] phone-8k: firstPartial=${r.partials[0] ?? "-"}ms finalAfterSpeechEnd=${r.finalMs ?? "-"}ms errors=${JSON.stringify(r.errors)}` + (showText ? ` text=${JSON.stringify(r.finals[0])}` : ""));
    expect(r.errors).toEqual([]);
    expect(r.finals.length).toBe(1);
  }, 60_000);

  it("cancelling mid-utterance stops the stream: no final, no error, session closed", async () => {
    const a = await audioFor("english.wav", "Hello, I am looking for a two bedroom apartment and I would like to know the price.");
    if (!a) return console.log("[assemblyai-integration] cancellation: no audio source; skipped");
    const r = await stream(a.pcm, { cancelAfterPartials: 1 });
    expect(r.cancelled).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.finals).toEqual([]);
    expect(r.closed).toBe(true);
  }, 60_000);
});
