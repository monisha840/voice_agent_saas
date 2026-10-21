/**
 * Real Sarvam Saaras STT adapter.
 *
 * Endpoint (documented): POST https://api.sarvam.ai/speech-to-text
 * multipart/form-data with fields: file (audio), model (e.g. "saaras:v3").
 * Reference: https://docs.sarvam.ai/api/getting-started/quickstart
 *
 * This file contains ALL Sarvam STT-specific request/response shapes. Timeouts, retries and the circuit breaker are
 * applied around it by the provider factory (adapters/ai/index.ts).
 */

import type { ISpeechToText, SttResult, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "./stt.interface.js";
import { SarvamSttStreamingSession, type SocketFactory } from "./sarvam.stt.streaming.js";
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError } from "../../shared/errors.js";
import { badResponse, httpFailure, transportFailure } from "./provider-errors.js";

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const PROVIDER = "sarvam";
const OPERATION = "stt.transcribe";
/** Backstop only, for use without the reliability wrapper; the wrapper passes its own (shorter) signal. */
const FALLBACK_TIMEOUT_MS = 20_000;

export class SarvamSttProvider implements ISpeechToText {
  readonly name = "sarvam-saaras";
  readonly capabilities: ProviderCapabilities = { languageHint: true, streamingStt: true };

  /** `socketFactory` is a test seam; production uses a real WebSocket. */
  constructor(private readonly socketFactory?: SocketFactory) {}

  /**
   * Live session on Sarvam's realtime endpoint (see sarvam.stt.streaming.ts for the contract). Retries and replay are
   * deliberately absent: a failed stream fails; the caller opens a new session for the next utterance.
   */
  async startStreaming(handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession> {
    const { sarvam, providers } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        PROVIDER,
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }
    return new SarvamSttStreamingSession(
      {
        apiKey: sarvam.apiKey,
        url: sarvam.sttRealtimeUrl,
        model: sarvam.sttRealtimeModel,
        streamType: sarvam.sttRealtimeStreamType,
        mode: sarvam.sttRealtimeMode,
        connectTimeoutMs: providers.sttTimeoutMs,
      },
      handlers,
      opts,
      this.socketFactory,
    );
  }

  async transcribe(audio: Buffer, opts?: ProviderCallOptions & { languageCode?: string }): Promise<SttResult> {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        PROVIDER,
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }

    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "utterance.wav");
    form.append("model", sarvam.sttModel);
    form.append("mode", sarvam.sttMode);
    if (opts?.languageCode) {
      form.append("language_code", opts.languageCode);
    }

    let response: Response;
    try {
      response = await fetch(SARVAM_STT_URL, {
        method: "POST",
        headers: { "api-subscription-key": sarvam.apiKey },
        body: form,
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
    // An utterance with no recognisable speech is a normal outcome, not a failure (and must not be retried): the
    // caller skips empty transcripts. Only a body without the field at all is unusable.
    if (typeof obj.transcript !== "string") throw badResponse(PROVIDER, OPERATION, "missing transcript");

    return {
      text: obj.transcript,
      languageCode: typeof obj.language_code === "string" ? obj.language_code : undefined,
    };
  }
}
