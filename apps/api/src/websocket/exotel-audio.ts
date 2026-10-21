/**
 * Exotel-specific audio framing, isolated from the AI providers and from the turn logic.
 *
 * Exotel AgentStream carries audio as JSON text frames whose `media.payload` is base64 of raw 16-bit little-endian
 * mono PCM (no container). This file converts between that wire form and the pipeline's internal format
 * (realtime/audio-format.ts); nothing outside the Exotel adapter should know about base64 or event shapes.
 */
import {
  audioFormat,
  decodeBase64Pcm,
  DEFAULT_SAMPLE_RATE,
  SUPPORTED_SAMPLE_RATES,
  type AudioFormat,
  type DecodedFrame,
} from "../realtime/audio-format.js";
import type { OutboundItem } from "../realtime/outbound-audio.js";

export interface ExotelMediaFormat {
  encoding?: string;
  sample_rate?: string | number;
  bit_rate?: string | number;
}

/** Internal format for the call from Exotel's `start.media_format`. An unknown rate falls back to 8 kHz. */
export function resolveExotelAudioFormat(mf?: ExotelMediaFormat): { format: AudioFormat; rateFellBack: boolean; encodingUnexpected: boolean } {
  const rate = Number(mf?.sample_rate ?? DEFAULT_SAMPLE_RATE);
  const rateFellBack = !SUPPORTED_SAMPLE_RATES.includes(rate);
  // Exotel documents raw PCM only. A different declared encoding is reported (not guessed at) so it is visible in logs.
  const encodingUnexpected = typeof mf?.encoding === "string" && !/pcm|s16le|linear|raw/i.test(mf.encoding);
  return { format: audioFormat(rateFellBack ? DEFAULT_SAMPLE_RATE : rate), rateFellBack, encodingUnexpected };
}

/** Decodes an inbound `media.payload`. Never throws. */
export function decodeExotelMedia(payload: unknown): DecodedFrame {
  return decodeBase64Pcm(payload);
}

/** One outbound audio chunk as a wire frame. */
export function exotelMediaItem(streamSid: string, pcm: Buffer): OutboundItem {
  return {
    payload: JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pcm.toString("base64") } }),
    weight: pcm.length,
    audio: true,
  };
}

/** A `clear` frame: Exotel flushes the audio it has buffered but not yet played (barge-in). */
export function exotelClearFrame(streamSid: string): string {
  return JSON.stringify({ event: "clear", stream_sid: streamSid });
}

/** A `mark` frame: Exotel echoes it back once all audio queued before it has played. */
export function exotelMarkItem(streamSid: string, name: string): OutboundItem {
  return { payload: JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name } }), weight: 0, audio: false };
}
