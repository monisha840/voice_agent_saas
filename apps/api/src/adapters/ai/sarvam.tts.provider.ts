/**
 * Real Sarvam Bulbul TTS adapter.
 *
 * Endpoint (documented): POST https://api.sarvam.ai/text-to-speech
 * Body: { text, target_language_code, speaker, model }
 * Response: { audios: [base64WavString, ...] }
 * Reference: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/rest-api
 *
 * This file contains ALL Sarvam TTS-specific request/response shapes.
 */

import type { ITextToSpeech, TtsResult } from "./tts.interface.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";

const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

export class SarvamTtsProvider implements ITextToSpeech {
  readonly name = "sarvam-bulbul";

  async synthesize(text: string, opts?: { languageCode?: string }): Promise<TtsResult> {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        "sarvam",
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }

    const body = {
      text,
      target_language_code: opts?.languageCode ?? "en-IN",
      speaker: "shubh",
      model: sarvam.ttsModel,
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
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Network error calling Sarvam TTS API", err);
    }

    if (!response.ok) {
      const text2 = await response.text().catch(() => "");
      throw new ProviderRequestError(
        "sarvam",
        `Sarvam TTS request failed (HTTP ${response.status}): ${text2.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Sarvam TTS returned a malformed response", err);
    }

    const obj = json as Record<string, unknown>;
    const audios = obj.audios as string[] | undefined;
    if (!audios || audios.length === 0) {
      throw new ProviderRequestError("sarvam", "Sarvam TTS response did not contain audio data");
    }

    return { audio: Buffer.from(audios[0], "base64"), format: "wav" };
  }
}
