/**
 * Pieces shared by the STT, LLM and TTS contracts, so that every provider (today Sarvam and the mocks; tomorrow
 * AssemblyAI, an OpenAI- or Anthropic-compatible endpoint, a local model) looks the same to the rest of the system.
 */

/** Optional last argument of every provider call. */
export interface ProviderCallOptions {
  /**
   * Cancellation: when it aborts, the provider must stop work and reject. Adapters pass it to their HTTP client
   * (fetch's `signal`); the reliability layer also enforces it even if an adapter ignores it.
   */
  signal?: AbortSignal;
  /** The call this request belongs to. For logs only; never sent to the provider. */
  callId?: string;
  /**
   * LLM: "none" = the model must answer in words and may not call a tool, although the tools stay defined (a provider
   * such as Sarvam refuses tool results in a request that defines no tools, and answers nothing when it has none).
   * Absent = the model decides.
   */
  toolChoice?: "none";
}

/**
 * What a provider can do, so callers can adapt instead of assuming. Every field is optional: a provider that says
 * nothing is assumed to do the basic job.
 */
export interface ProviderCapabilities {
  /** LLM: supports tool/function calling. */
  toolCalling?: boolean;
  /** LLM: may return several tool calls in one response. */
  parallelToolCalls?: boolean;
  /** TTS: honours `voice`. When false the voice option is not sent. */
  voiceSelection?: boolean;
  /** STT/TTS: honours `languageCode`. */
  languageHint?: boolean;
  /** LLM: can stream a response as it is generated (chatStream), not only return it whole. */
  streamingLlm?: boolean;
  /** STT: can transcribe a live audio stream (startStreaming), not only a finished utterance. */
  streamingStt?: boolean;
  /** TTS: can synthesize text as it arrives and stream audio back (startStreaming), not only one request per reply. */
  streamingTts?: boolean;
}
