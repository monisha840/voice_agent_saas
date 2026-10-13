/**
 * STT provider benchmark: streams the SAME audio through each streaming STT adapter in real time and reports latency.
 *
 *   pnpm --filter @voice-agent/api exec tsx src/scripts/stt-benchmark.ts [options]
 *
 *   --audio-dir <dir>     fixtures (default ./bench-audio, git-ignored): english.wav, indian-english.wav,
 *                         mixed-exploratory.wav, tamil.wav (any 16-bit PCM WAV; converted to 8 kHz mono here)
 *   --providers a,b       sarvam,assemblyai (default both; each needs its API key, else its rows say "skipped")
 *   --runs N              repetitions per provider/language (default 3)
 *   --synthesize          first write the fixtures from Sarvam TTS (needs SARVAM_API_KEY). This is SYNTHETIC speech: it
 *                         checks the plumbing and gives comparable timings, but says little about phone-call accuracy.
 *                         Real 8 kHz recordings are better; keep them out of the repository if they hold real voices/PII.
 *   --session-gap-ms N    pause between sessions (default 13000 for AssemblyAI: its free tier allows only 5 NEW sessions
 *                         per minute and answers more with error 1008; use 0 on a paid account)
 *   --try-unsupported     also run languages a provider does not list (AssemblyAI + Tamil), with NO language hint, to see
 *                         what actually happens. Those rows are labelled "UNSUPPORTED ... exploratory"; they are not support.
 *   --show-text           print transcripts (OFF by default: transcripts can contain personal data)
 *   --json <file>         also write the raw measurements
 *
 * What is measured, per run, in wall-clock milliseconds, with audio paced in real time (100 ms frames):
 *   speech start -> first partial,  speech end -> final,  speech start -> final.
 * "Speech end" is when the last audio frame (after 700 ms of trailing silence, like our VAD) has been sent and the
 * utterance is closed. Session set-up time is inside the first run's numbers for both providers alike.
 *
 * Tamil is run for Sarvam only: AssemblyAI streaming does not list Tamil, so that row is reported as unsupported, not
 * as a result. Mixed Tamil-English ("Tanglish") is exploratory for AssemblyAI and labelled that way.
 * Nothing here estimates or fills in numbers; a row with no data says why.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv, getConfig } from "../config/env.js";
import { parseWav, resamplePcm16, ttsAudioToPcm, pcm16ToWav } from "../audio/pcm.js";
import { SarvamSttProvider } from "../adapters/ai/sarvam.stt.provider.js";
import { SarvamTtsProvider } from "../adapters/ai/sarvam.tts.provider.js";
import { AssemblyAiSttProvider, assemblyAiSupportsLanguage } from "../adapters/ai/assemblyai/assemblyai.stt.provider.js";
import type { ISpeechToText } from "../adapters/ai/stt.interface.js";
import { formatReport, type BenchRow, type BenchRun } from "./stt-benchmark-report.js";

interface Fixture {
  file: string;
  label: string;
  /** BCP-47 hint passed to the provider. */
  lang: string;
  phrase: string;
  /** Providers for which this fixture is exploratory or unsupported, with the reason. */
  note?: Record<string, string>;
}

const FIXTURES: Fixture[] = [
  { file: "english.wav", label: "English", lang: "en-IN", phrase: "Hello, I am looking for a two bedroom apartment." },
  { file: "indian-english.wav", label: "Indian English", lang: "en-IN", phrase: "Can you tell me the price and location of the project?" },
  {
    file: "mixed-exploratory.wav",
    label: "Mixed Tamil-English (exploratory)",
    lang: "en-IN",
    phrase: "2 BHK price evlo?",
    note: { assemblyai: "exploratory: Tamil is not a supported AssemblyAI streaming language" },
  },
  { file: "tamil.wav", label: "Tamil", lang: "ta-IN", phrase: "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?" },
  { file: "tamil-pure.wav", label: "Tamil (pure)", lang: "ta-IN", phrase: "இந்த திட்டத்தில் இரண்டு படுக்கையறை வீட்டின் விலை எவ்வளவு?" },
];

const FRAME_MS = 100;
const TRAILING_SILENCE_MS = 700;
const RUN_TIMEOUT_MS = 20_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadPcm8k(path: string): Buffer {
  const wav = parseWav(readFileSync(path));
  if (!wav) throw new Error(`${path} is not a WAV file`);
  return resamplePcm16(wav.pcm, wav.sampleRate, 8000);
}

async function runOnce(stt: ISpeechToText, pcm: Buffer, lang: string, showText: boolean): Promise<BenchRun> {
  let firstPartialAt: number | undefined;
  let finalAt: number | undefined;
  let partials = 0;
  let text: string | undefined;
  let error: string | undefined;
  const session = await stt.startStreaming!(
    {
      onPartial: () => {
        partials++;
        firstPartialAt ??= Date.now();
      },
      onFinal: (e) => {
        finalAt ??= Date.now();
        text ??= e.text;
      },
      onError: (e) => {
        error ??= `${e.name}:${(e as { category?: string }).category ?? "unknown"}${(e as { status?: number }).status ? `:code${(e as { status?: number }).status}` : ""}`;
      },
      onClose: () => undefined,
    },
    { sampleRate: 8000, languageCode: lang || undefined },
  );
  const frameBytes = (8000 * 2 * FRAME_MS) / 1000;
  const silence = Buffer.alloc(frameBytes);
  session.startUtterance();
  const speechStartAt = Date.now();
  for (let i = 0; i < pcm.length && session.open; i += frameBytes) {
    session.sendAudio(pcm.subarray(i, i + frameBytes));
    await sleep(FRAME_MS);
  }
  for (let t = 0; t < TRAILING_SILENCE_MS && session.open; t += FRAME_MS) {
    session.sendAudio(silence);
    await sleep(FRAME_MS);
  }
  const speechEndAt = Date.now();
  session.endUtterance();
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (finalAt === undefined && error === undefined && Date.now() < deadline) await sleep(20);
  session.cancel();
  if (finalAt === undefined && error === undefined) error = "timeout:no-final";
  if (showText && text !== undefined) console.log(`    transcript: ${JSON.stringify(text)}`);
  return {
    firstPartialMs: firstPartialAt === undefined ? undefined : firstPartialAt - speechStartAt,
    finalMs: finalAt === undefined ? undefined : finalAt - speechEndAt,
    totalMs: finalAt === undefined ? undefined : finalAt - speechStartAt,
    partials,
    emptyFinal: finalAt !== undefined && (text ?? "").trim() === "",
    error,
  };
}

async function main() {
  loadEnv();
  const cfg = getConfig();
  const dir = resolve(arg("audio-dir") ?? "bench-audio");
  const runs = Math.max(1, Number(arg("runs") ?? 3));
  const showText = flag("show-text");
  const gapArg = arg("session-gap-ms");
  const wanted = (arg("providers") ?? "sarvam,assemblyai").split(",").map((s) => s.trim());

  if (flag("synthesize")) {
    if (!cfg.sarvam.apiKey) throw new Error("--synthesize needs SARVAM_API_KEY");
    mkdirSync(dir, { recursive: true });
    for (const f of FIXTURES) {
      const tts = await new SarvamTtsProvider().synthesize(f.phrase, { languageCode: f.lang, sampleRate: 8000 });
      writeFileSync(join(dir, f.file), pcm16ToWav(ttsAudioToPcm(tts.audio, tts.format, 8000), 8000));
      console.log(`wrote ${f.file} (synthetic Sarvam TTS, 8 kHz)`);
    }
  }

  const providers: Array<{ name: string; stt: ISpeechToText | null; why?: string; supports: (lang: string) => boolean }> = [];
  if (wanted.includes("sarvam")) {
    providers.push({
      name: "Sarvam",
      stt: cfg.sarvam.apiKey ? new SarvamSttProvider() : null,
      why: "SARVAM_API_KEY not set",
      supports: () => true,
    });
  }
  if (wanted.includes("assemblyai")) {
    providers.push({
      name: `AssemblyAI (${cfg.assemblyai.model})`,
      stt: cfg.assemblyai.apiKey ? new AssemblyAiSttProvider() : null,
      why: "ASSEMBLYAI_API_KEY not set",
      supports: (lang) => assemblyAiSupportsLanguage(cfg.assemblyai.model, lang),
    });
  }

  const rows: BenchRow[] = [];
  for (const f of FIXTURES) {
    for (const p of providers) {
      const key = p.name.toLowerCase().startsWith("assembly") ? "assemblyai" : "sarvam";
      const base = { provider: p.name, language: f.label, note: f.note?.[key] };
      const path = join(dir, f.file);
      if (!p.stt) rows.push({ ...base, skipped: p.why, runs: [] });
      else if (!p.supports(f.lang) && !flag("try-unsupported")) rows.push({ ...base, skipped: "language not supported by this provider (not run, not a result)", runs: [] });
      else if (!existsSync(path)) rows.push({ ...base, skipped: `no fixture ${f.file} in ${dir}`, runs: [] });
      else {
        const pcm = loadPcm8k(path);
        const unsupported = !p.supports(f.lang);
        if (unsupported) base.note = "UNSUPPORTED language: exploratory only, not a supported result";
        const results: BenchRun[] = [];
        for (let i = 0; i < runs; i++) {
          const gap = gapArg !== undefined ? Number(gapArg) : key === "assemblyai" ? 13_000 : 0;
          if (gap > 0 && results.length + rows.length > 0) await sleep(gap);
          console.log(`${p.name} / ${f.label} / run ${i + 1}/${runs}`);
          results.push(await runOnce(p.stt, pcm, unsupported ? "" : f.lang, showText).catch((e) => ({ partials: 0, emptyFinal: false, error: `${(e as Error).name}` })));
        }
        rows.push({ ...base, runs: results });
      }
    }
  }
  console.log(`\n${formatReport(rows)}\n`);
  console.log("Audio: 8 kHz mono PCM streamed in real time (100 ms frames). Medians over the runs shown. Transcripts are not printed unless --show-text.");
  const out = arg("json");
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
