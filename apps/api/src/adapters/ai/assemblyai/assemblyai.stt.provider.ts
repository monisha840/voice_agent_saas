/**
 * EXPERIMENTAL — AssemblyAI realtime STT provider, behind the same ISpeechToText interface as every other provider.
 * Streaming only: it has no batch transcribe(). Selected only by REALTIME_STT_PROVIDER=assemblyai (see
 * adapters/ai/index.ts); never the default and never a fallback.
 */
import type { ISpeechToText, SttResult, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "../stt.interface.js";
import type { ProviderCallOptions, ProviderCapabilities } from "../provider-common.js";
import { getConfig } from "../../../config/env.js";
import { ProviderConfigError } from "../../../shared/errors.js";
import { ASSEMBLYAI_PROVIDER, AssemblyAiSttStreamingSession, type SocketFactory } from "./assemblyai.stt.streaming.js";

/**
 * Languages (base subtag) the docs list for streaming models. The English-only model takes English only. Anything else
 * (Tamil among it) is refused up front with a clear error instead of being transcribed wrongly.
 */
const ENGLISH_ONLY_MODELS = new Set(["universal-streaming-english"]);
const MULTILINGUAL_BASES = new Set(["en", "es", "de", "fr", "pt", "it", "tr", "nl", "sv", "no", "da", "fi", "hi", "vi", "ar", "he", "ja", "ur", "zh"]);

export function assemblyAiSupportsLanguage(model: string, languageCode: string | undefined): boolean {
  if (!languageCode) return true; // no hint: the model's own default / detection
  const base = languageCode.toLowerCase().split(/[-_]/)[0];
  return ENGLISH_ONLY_MODELS.has(model) ? base === "en" : MULTILINGUAL_BASES.has(base);
}

export class AssemblyAiSttProvider implements ISpeechToText {
  readonly name = ASSEMBLYAI_PROVIDER;
  readonly capabilities: ProviderCapabilities = { streamingStt: true, languageHint: false };

  /** `socketFactory` is a test seam (local mock server); production uses a real WebSocket. */
  constructor(private readonly socketFactory?: SocketFactory) {}

  async transcribe(_audio: Buffer, _opts?: ProviderCallOptions & { languageCode?: string }): Promise<SttResult> {
    throw new ProviderConfigError(ASSEMBLYAI_PROVIDER, "The AssemblyAI experiment is streaming-only. Set REALTIME_STT_STREAMING=true.");
  }

  async startStreaming(handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession> {
    const { assemblyai, providers } = getConfig();
    if (!assemblyai.apiKey) {
      throw new ProviderConfigError(ASSEMBLYAI_PROVIDER, "ASSEMBLYAI_API_KEY is not configured (REALTIME_STT_PROVIDER=assemblyai requires it).");
    }
    if (!assemblyAiSupportsLanguage(assemblyai.model, opts.languageCode)) {
      throw new ProviderConfigError(
        ASSEMBLYAI_PROVIDER,
        `AssemblyAI streaming model "${assemblyai.model}" does not support language "${opts.languageCode}". Use REALTIME_STT_PROVIDER=sarvam for this agent.`,
      );
    }
    return new AssemblyAiSttStreamingSession(
      {
        apiKey: assemblyai.apiKey,
        url: assemblyai.url,
        model: assemblyai.model,
        minTurnSilenceMs: assemblyai.minTurnSilenceMs,
        maxTurnSilenceMs: assemblyai.maxTurnSilenceMs,
        flushGraceMs: assemblyai.flushGraceMs,
        connectTimeoutMs: providers.sttTimeoutMs,
      },
      handlers,
      opts,
      this.socketFactory,
    );
  }
}
