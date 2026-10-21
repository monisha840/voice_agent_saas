/**
 * ISpeechToText — the only STT contract the conversation loop depends on.
 * Failures are ProviderRequestError / ProviderConfigError (shared/errors.ts); silence is NOT a failure: return an
 * empty `text`.
 *
 * Two modes, one interface:
 *  - transcribe(): one finished utterance in, one transcript out (every provider has this).
 *  - startStreaming(): OPTIONAL. A live session: audio goes in as it is captured, partial and final transcripts come
 *    out as events. Providers that cannot stream simply do not define it (`capabilities.streamingStt`).
 */
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";
import type { ProviderRequestError, ProviderConfigError } from "../../shared/errors.js";

export interface SttResult {
  text: string;
  languageCode?: string;
}

export interface SttTranscriptEvent {
  text: string;
  /** The provider's own utterance counter, when it has one. Used only to recognise a repeated event. */
  utteranceIdx?: number;
  languageCode?: string;
}

/**
 * What a streaming session reports. Delivery is in order and never after close()/cancel() or after onError.
 * Handlers must not throw (a throwing handler is isolated and logged, not propagated into the provider).
 */
export interface SttStreamHandlers {
  /** Interim text for the utterance in progress. Transient: never a conversation message. */
  onPartial(event: SttTranscriptEvent): void;
  /** Finished text for one utterance (one per utterance_end). May be empty (no recognisable speech). */
  onFinal(event: SttTranscriptEvent): void;
  /** The session is unusable and has been torn down. No further events except onClose. */
  onError(error: ProviderRequestError | ProviderConfigError): void;
  /** The session ended (after onError, close(), cancel() or the provider closing it). Exactly once. */
  onClose(): void;
}

export interface SttStreamOptions extends ProviderCallOptions {
  /** BCP-47 hint (e.g. "ta-IN"); undefined = let the provider detect the language. */
  languageCode?: string;
  /** Rate of the PCM passed to sendAudio (16-bit LE mono). Any rate conversion the provider needs is its own business. */
  sampleRate: number;
  /** Log-only identifiers. */
  agentId?: string;
  organizationId?: string;
  /** Upper bound on audio held while the connection is being made or is congested. Beyond it the session fails. */
  maxQueuedBytes?: number;
}

export interface SttStreamingSession {
  /** True until the session has errored, closed or been cancelled. */
  readonly open: boolean;
  /** Queues raw PCM for the current utterance. Returns false (and sends nothing) if the session is no longer usable. */
  sendAudio(pcm: Buffer): boolean;
  /** The caller started speaking (the application owns turn detection). */
  startUtterance(): boolean;
  /** The caller stopped speaking: the provider should now produce the final transcript for this utterance. */
  endUtterance(): boolean;
  /** Graceful: tell the provider we are done, let it finish, then release. Resolves when released. */
  close(): Promise<void>;
  /** Immediate: drop everything, release the connection, emit nothing further except onClose. */
  cancel(): void;
}

export interface ISpeechToText {
  readonly name: string;
  readonly capabilities?: ProviderCapabilities;
  /** audio: raw audio bytes for one utterance (WAV/PCM). */
  transcribe(audio: Buffer, opts?: ProviderCallOptions & { languageCode?: string }): Promise<SttResult>;
  /**
   * Opens a live session. Returns at once; connecting happens in the background and audio sent meanwhile is held
   * (bounded). Connection and later failures arrive through `handlers.onError`. A refusal that is known up front
   * (circuit open, missing credentials) rejects/throws instead.
   */
  startStreaming?(handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession>;
}
