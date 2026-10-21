/**
 * The ONE internal audio representation of the real-time pipeline.
 *
 *   encoding:     PCM, signed 16-bit, little-endian ("pcm_s16le")
 *   channels:     1 (mono)
 *   sample width: 2 bytes
 *   sample rate:  the call's negotiated rate: 8000 Hz for telephony (Exotel's default); 16000 / 24000 are accepted
 *   container:    NONE. Live frames are raw samples; there are no WAV headers on the live path.
 *
 * Everything between the telephony adapter and the AI providers (VAD, turn control, buffers) deals only in this
 * format. Telephony-specific decoding (base64, JSON events) lives in the telephony adapter
 * (websocket/exotel-audio.ts); provider-specific wrapping (a WAV header for Sarvam STT, WAV parsing of TTS output)
 * lives at the provider edge (audio/pcm.ts + the AI adapters).
 */

export interface AudioFormat {
  encoding: "pcm_s16le";
  channels: 1;
  sampleWidthBytes: 2;
  sampleRate: number;
}

export const SUPPORTED_SAMPLE_RATES: readonly number[] = [8000, 16000, 24000];
export const DEFAULT_SAMPLE_RATE = 8000;

export function audioFormat(sampleRate: number): AudioFormat {
  return {
    encoding: "pcm_s16le",
    channels: 1,
    sampleWidthBytes: 2,
    sampleRate: SUPPORTED_SAMPLE_RATES.includes(sampleRate) ? sampleRate : DEFAULT_SAMPLE_RATE,
  };
}

/** Largest single inbound audio frame accepted (Exotel's documented chunk ceiling is 100,000 bytes). */
export const MAX_INBOUND_FRAME_BYTES = 100_000;

export type FrameRejection = "not_string" | "empty" | "too_large" | "bad_base64" | "odd_length";

export type DecodedFrame = { ok: true; pcm: Buffer } | { ok: false; reason: FrameRejection };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates and decodes one base64 audio payload into raw PCM. Never throws: a hostile or broken peer produces a
 * rejection reason, which the caller counts and drops. Size is checked BEFORE decoding so an oversized payload
 * costs no allocation.
 */
export function decodeBase64Pcm(payload: unknown, maxBytes = MAX_INBOUND_FRAME_BYTES): DecodedFrame {
  if (typeof payload !== "string") return { ok: false, reason: "not_string" };
  if (payload.length === 0) return { ok: false, reason: "empty" };
  if (Math.floor((payload.length * 3) / 4) > maxBytes + 2) return { ok: false, reason: "too_large" };
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) return { ok: false, reason: "bad_base64" };
  const pcm = Buffer.from(payload, "base64");
  if (pcm.length === 0) return { ok: false, reason: "empty" };
  if (pcm.length > maxBytes) return { ok: false, reason: "too_large" };
  if (pcm.length % 2 !== 0) return { ok: false, reason: "odd_length" };
  return { ok: true, pcm };
}
