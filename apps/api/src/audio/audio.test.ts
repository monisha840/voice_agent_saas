import { describe, it, expect } from "vitest";
import {
  chunkPcmForExotel,
  parseWav,
  pcm16ToWav,
  pcmRms,
  resamplePcm16,
  ttsAudioToPcm,
} from "./pcm.js";
import { TurnDetector } from "./turn-detector.js";
import { encodeMockSpeech, MockSttProvider } from "../adapters/ai/mock.stt.provider.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";

/** n samples of a square wave at the given amplitude. */
function tone(samples: number, amplitude: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}
const FRAME = 800; // samples per 100 ms at 8 kHz
const loudFrame = () => tone(FRAME, 8000);
const quietFrame = () => Buffer.alloc(FRAME * 2);

describe("PCM / WAV helpers", () => {
  it("WAV round-trips through pcm16ToWav/parseWav", () => {
    const pcm = tone(400, 1000);
    const parsed = parseWav(pcm16ToWav(pcm, 16000))!;
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.pcm.equals(pcm)).toBe(true);
  });

  it("parseWav returns null for non-WAV and throws for unsupported WAV encodings", () => {
    expect(parseWav(Buffer.from("not a wav file at all"))).toBeNull();
    const wav = pcm16ToWav(tone(10, 1), 8000);
    wav.writeUInt16LE(3, 20); // IEEE float
    expect(() => parseWav(wav)).toThrow(/Unsupported WAV/);
  });

  it("resamples 16 kHz -> 8 kHz to half the samples, and is a no-op at equal rates", () => {
    const pcm = tone(1600, 5000);
    expect(resamplePcm16(pcm, 16000, 8000).length).toBe(1600);
    expect(resamplePcm16(pcm, 8000, 8000)).toBe(pcm);
  });

  it("ttsAudioToPcm strips the WAV header, converts the rate, and rejects MP3", () => {
    const wav16k = pcm16ToWav(tone(1600, 5000), 16000);
    const pcm = ttsAudioToPcm(wav16k, "wav", 8000);
    expect(pcm.length).toBe(1600); // 800 samples * 2 bytes, no 44-byte header
    expect(() => ttsAudioToPcm(Buffer.from([0, 0]), "mp3", 8000)).toThrow(/MP3/);
  });

  it("chunks into Exotel-valid frames: >=3200 bytes, multiple of 320, tail padded with silence", () => {
    const pcm = tone(5000, 3000); // 10,000 bytes
    const chunks = chunkPcmForExotel(pcm);
    expect(chunks).toHaveLength(4); // 4 * 3200 = 12,800
    for (const c of chunks) {
      expect(c.length).toBeGreaterThanOrEqual(3200);
      expect(c.length % 320).toBe(0);
    }
    expect(Buffer.concat(chunks).subarray(0, pcm.length).equals(pcm)).toBe(true);
    expect(chunks[3].subarray(10_000 - 9600).every((b) => b === 0)).toBe(true);
    expect(chunkPcmForExotel(Buffer.alloc(0))).toEqual([]);
    expect(() => chunkPcmForExotel(pcm, 1000)).toThrow();
  });

  it("the mock TTS output converts to valid Exotel chunks end to end", async () => {
    const { audio, format } = await new MockTtsProvider().synthesize("hi", { sampleRate: 8000 });
    const chunks = chunkPcmForExotel(ttsAudioToPcm(audio, format, 8000));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length % 320).toBe(0));
  });

  it("measures loudness", () => {
    expect(pcmRms(quietFrame())).toBe(0);
    expect(pcmRms(loudFrame())).toBeCloseTo(8000, 0);
  });
});

describe("TurnDetector (continuous 100 ms frames)", () => {
  const make = (over: Partial<ConstructorParameters<typeof TurnDetector>[0]> = {}) =>
    new TurnDetector({
      sampleRate: 8000,
      energyThreshold: 500,
      minSpeechMs: 250,
      endSilenceMs: 700,
      maxUtteranceMs: 15000,
      preRollMs: 200,
      ...over,
    });

  it("ignores silence, then ends the turn ~700 ms after speech stops (not after 8 s)", () => {
    const d = make();
    for (let i = 0; i < 20; i++) expect(d.push(quietFrame())).toBeNull(); // 2 s of silence
    for (let i = 0; i < 5; i++) expect(d.push(loudFrame())).toBeNull(); // 500 ms of speech
    expect(d.speaking).toBe(true);
    let utterance: Buffer | null = null;
    let silentFrames = 0;
    while (!utterance && silentFrames < 50) {
      utterance = d.push(quietFrame());
      silentFrames++;
    }
    expect(silentFrames).toBe(7); // 700 ms of quiet
    expect(utterance).not.toBeNull();
    // 2 pre-roll + 5 speech + 7 silence frames
    expect(utterance!.length).toBe((2 + 5 + 7) * FRAME * 2);
    expect(d.speaking).toBe(false);
  });

  it("keeps a short pause inside one utterance", () => {
    const d = make();
    for (let i = 0; i < 3; i++) d.push(loudFrame());
    for (let i = 0; i < 3; i++) expect(d.push(quietFrame())).toBeNull(); // 300 ms pause < 700 ms
    for (let i = 0; i < 3; i++) d.push(loudFrame());
    let utterance: Buffer | null = null;
    for (let i = 0; i < 7; i++) utterance = d.push(quietFrame()) ?? utterance;
    expect(utterance).not.toBeNull();
    expect(utterance!.length).toBe((3 + 3 + 3 + 7) * FRAME * 2);
  });

  it("discards blips shorter than minSpeechMs", () => {
    const d = make();
    d.push(loudFrame()); // 100 ms < 250 ms
    let utterance: Buffer | null = null;
    for (let i = 0; i < 10; i++) utterance = d.push(quietFrame()) ?? utterance;
    expect(utterance).toBeNull();
    expect(d.speaking).toBe(false);
  });

  it("force-ends an utterance at maxUtteranceMs", () => {
    const d = make({ maxUtteranceMs: 1000 });
    let utterance: Buffer | null = null;
    for (let i = 0; i < 10 && !utterance; i++) utterance = d.push(loudFrame());
    expect(utterance).not.toBeNull();
  });
});

describe("mock speech survives the real audio path", () => {
  it("scripted text -> PCM frames -> turn detector -> WAV -> mock STT returns the exact text", async () => {
    const text = "I'm looking for a 2 BHK. My budget is around 70 lakhs.";
    const speech = encodeMockSpeech(text);
    const d = new TurnDetector({
      sampleRate: 8000,
      energyThreshold: 500,
      minSpeechMs: 250,
      endSilenceMs: 700,
      maxUtteranceMs: 15000,
      preRollMs: 200,
    });
    for (let i = 0; i < 6; i++) d.push(quietFrame());
    let utterance: Buffer | null = null;
    for (let i = 0; i < speech.length; i += 1600) d.push(speech.subarray(i, i + 1600));
    for (let i = 0; i < 10 && !utterance; i++) utterance = d.push(quietFrame());
    expect(utterance).not.toBeNull();
    const { text: heard } = await new MockSttProvider().transcribe(pcm16ToWav(utterance!, 8000));
    expect(heard).toBe(text);
  });
});
