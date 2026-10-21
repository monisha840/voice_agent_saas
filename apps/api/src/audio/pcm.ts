/**
 * PCM / WAV helpers for the Exotel AgentStream audio path.
 *
 * Exotel streams raw 16-bit signed little-endian mono PCM (8 kHz by
 * default; 16 kHz / 24 kHz selectable) as base64, and expects audio sent
 * back in the same raw format, in chunks of 3,200-100,000 bytes that are
 * a multiple of 320. Sarvam STT/TTS speak WAV. These helpers convert
 * between the two without any native dependency.
 */

export const EXOTEL_MIN_CHUNK_BYTES = 3200;
export const EXOTEL_CHUNK_MULTIPLE = 320;

export interface DecodedAudio {
  /** 16-bit LE mono PCM. */
  pcm: Buffer;
  sampleRate: number;
}

/**
 * Parses a WAV container (16-bit PCM only). Returns null if `buf` is not
 * a RIFF/WAVE file; throws if it is WAV but in an unsupported encoding.
 */
export function parseWav(buf: Buffer): DecodedAudio | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // Streaming encoders may write 0 / 0xFFFFFFFF as the size: take the rest.
      const end = size === 0 || body + size > buf.length ? buf.length : body + size;
      data = buf.subarray(body, end);
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (PCM in practice for our sources)
  if ((fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) || fmt.bits !== 16) {
    throw new Error(`Unsupported WAV encoding (format ${fmt.audioFormat}, ${fmt.bits}-bit); expected 16-bit PCM`);
  }
  const usable = data.length - (data.length % (2 * fmt.channels));
  const pcm =
    fmt.channels === 1 ? Buffer.from(data.subarray(0, usable)) : mixToMono(data.subarray(0, usable), fmt.channels);
  return { pcm, sampleRate: fmt.sampleRate };
}

function mixToMono(pcm: Buffer, channels: number): Buffer {
  const frames = pcm.length / (2 * channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

/** Linear-interpolation resampler for 16-bit mono PCM. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;
  const inSamples = pcm.length / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const i0 = Math.min(Math.floor(pos), inSamples - 1);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

/**
 * Converts provider TTS output to raw 16-bit mono PCM at `targetRate`.
 * WAV is parsed (header stripped, resampled if needed). Non-WAV bytes are
 * treated as already-raw PCM at `targetRate`. MP3 cannot be decoded here.
 */
export function ttsAudioToPcm(audio: Buffer, format: "wav" | "mp3", targetRate: number): Buffer {
  if (format === "mp3") {
    throw new Error("MP3 TTS output cannot be sent to Exotel; request WAV/PCM from the TTS provider");
  }
  const wav = parseWav(audio);
  if (!wav) return audio.subarray(0, audio.length - (audio.length % 2));
  return resamplePcm16(wav.pcm, wav.sampleRate, targetRate);
}

/**
 * Splits PCM into Exotel-compatible chunks: every chunk is `chunkBytes`
 * (default 3,200 = 200 ms at 8 kHz; within 3,200-100,000 and a multiple of
 * 320). The tail is padded with silence so no chunk is undersized.
 */
export function chunkPcmForExotel(pcm: Buffer, chunkBytes = EXOTEL_MIN_CHUNK_BYTES): Buffer[] {
  if (chunkBytes < EXOTEL_MIN_CHUNK_BYTES || chunkBytes > 100_000 || chunkBytes % EXOTEL_CHUNK_MULTIPLE !== 0) {
    throw new Error(`Invalid Exotel chunk size ${chunkBytes}`);
  }
  if (pcm.length === 0) return [];
  const padded =
    pcm.length % chunkBytes === 0 ? pcm : Buffer.concat([pcm, Buffer.alloc(chunkBytes - (pcm.length % chunkBytes))]);
  const chunks: Buffer[] = [];
  for (let i = 0; i < padded.length; i += chunkBytes) chunks.push(padded.subarray(i, i + chunkBytes));
  return chunks;
}

/** Wraps 16-bit mono PCM in a WAV header (for Sarvam STT). */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Root-mean-square amplitude of 16-bit LE PCM (0..32768). */
export function pcmRms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

/** Duration in ms of `bytes` of 16-bit mono PCM at `sampleRate`. */
export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}
