/**
 * Real Sarvam Saaras STT adapter.
 *
 * Endpoint (documented): POST https://api.sarvam.ai/speech-to-text
 * multipart/form-data with fields: file (audio), model (e.g. "saaras:v3").
 * Reference: https://docs.sarvam.ai/api/getting-started/quickstart
 *
 * This file contains ALL Sarvam STT-specific request/response shapes.
 */

import type { ISpeechToText, SttResult } from "./stt.interface.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

export class SarvamSttProvider implements ISpeechToText {
  readonly name = "sarvam-saaras";

  async transcribe(audio: Buffer, opts?: { languageCode?: string }): Promise<SttResult> {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        "sarvam",
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }

    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "utterance.wav");
    form.append("model", sarvam.sttModel);
    if (opts?.languageCode) {
      form.append("language_code", opts.languageCode);
    }

    let response: Response;
    try {
      response = await fetch(SARVAM_STT_URL, {
        method: "POST",
        headers: { "api-subscription-key": sarvam.apiKey },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Network error calling Sarvam STT API", err);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderRequestError(
        "sarvam",
        `Sarvam STT request failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Sarvam STT returned a malformed response", err);
    }

    const obj = json as Record<string, unknown>;
    const transcript = typeof obj.transcript === "string" ? obj.transcript : "";
    if (!transcript) {
      throw new ProviderRequestError("sarvam", "Sarvam STT response did not contain a transcript");
    }

    return {
      text: transcript,
      languageCode: typeof obj.language_code === "string" ? obj.language_code : undefined,
    };
  }
}
