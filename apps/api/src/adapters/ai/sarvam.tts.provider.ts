/**
 * Real Sarvam Bulbul TTS adapter.
 *
 * Endpoint (documented): POST https://api.sarvam.ai/text-to-speech
 * Body: { text, language_code, speaker, model, speech_sample_rate, output_audio_codec }
 * Response: { audios: [base64WavString, ...] }
 * Reference: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/rest-api
 *
 * This file contains ALL Sarvam TTS-specific request/response shapes. Timeouts, retries and the circuit breaker are
 * applied around it by the provider factory (adapters/ai/index.ts).
 */

import type { ITextToSpeech, TtsOptions, TtsResult, TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions } from "./tts.interface.js";
import { SarvamTtsStreamingSession } from "./sarvam.tts.streaming.js";
import type { SocketFactory } from "./sarvam.stt.streaming.js";
import type { ProviderCapabilities } from "./provider-common.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError } from "../../shared/errors.js";
import { badResponse, httpFailure, transportFailure } from "./provider-errors.js";

const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";
const PROVIDER = "sarvam";
const OPERATION = "tts.synthesize";
/** Sarvam's speaker used when the agent has no voice configured (the previous hard-coded behaviour). */
export const SARVAM_DEFAULT_SPEAKER = "shubh";
/** Backstop only, for use without the reliability wrapper; the wrapper passes its own (shorter) signal. */
const FALLBACK_TIMEOUT_MS = 20_000;

export class SarvamTtsProvider implements ITextToSpeech {
  readonly name = "sarvam-bulbul";
  readonly capabilities: ProviderCapabilities = { voiceSelection: true, languageHint: true, streamingTts: true };

  constructor(private readonly socketFactory?: SocketFactory) {}

  /** Opens a streaming session (wss text-to-speech/ws). All protocol details: sarvam.tts.streaming.ts. */
  async startStreaming(handlers: TtsStreamHandlers, opts: TtsStreamOptions): Promise<TtsStreamingSession> {
    const { sarvam, providers } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(PROVIDER, "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.");
    }
    return new SarvamTtsStreamingSession(
      { apiKey: sarvam.apiKey, url: sarvam.ttsStreamUrl, model: sarvam.ttsModel, defaultSpeaker: SARVAM_DEFAULT_SPEAKER, connectTimeoutMs: providers.ttsTimeoutMs },
      handlers,
      opts,
      this.socketFactory,
    );
  }

  async synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        PROVIDER,
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }

    const body = {
      text,
      // Per current Sarvam docs the field is `language_code` (we previously sent `target_language_code`).
      language_code: opts?.languageCode ?? "en-IN",
      // The agent's configured voice; an unknown speaker is rejected by Sarvam (400), which the caller turns into
      // "use the provider default" (adapters/ai/tts-voice.ts).
      speaker: opts?.voice ?? SARVAM_DEFAULT_SPEAKER,
      model: sarvam.ttsModel,
      // WAV at the telephony rate; our audio layer strips the header and resamples if Sarvam returns another rate.
      speech_sample_rate: opts?.sampleRate ?? 8000,
      output_audio_codec: "wav",
    };

    let response: Response;
    try {
      response = await fetch(SARVAM_TTS_URL, {
        method: "POST",
        headers: {
          "api-subscription-key": sarvam.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: opts?.signal ?? AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
      });
    } catch (err) {
      throw transportFailure(PROVIDER, OPERATION, err);
    }

    if (!response.ok) throw httpFailure(PROVIDER, OPERATION, response);

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw badResponse(PROVIDER, OPERATION, "not JSON", err);
    }

    const obj = (json ?? {}) as Record<string, unknown>;
    const audios = obj.audios as string[] | undefined;
    if (!audios || audios.length === 0 || typeof audios[0] !== "string") throw badResponse(PROVIDER, OPERATION, "no audio data");

    return { audio: Buffer.from(audios[0], "base64"), format: "wav" };
  }
}
