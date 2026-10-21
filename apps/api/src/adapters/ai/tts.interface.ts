/**
 * ITextToSpeech — the only TTS contract the conversation loop depends on.
 * Failures are ProviderRequestError / ProviderConfigError (shared/errors.ts). An adapter that is given a voice it does
 * not know should fail with category "invalid_request" so the caller can fall back to the provider default.
 */
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";
import type { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";

export interface TtsResult {
  /** Raw audio bytes (decoded from the provider's response). */
  audio: Buffer;
  format: "wav" | "mp3";
}

export interface TtsOptions extends ProviderCallOptions {
  languageCode?: string;
  /** Preferred output rate in Hz (Exotel needs 8000 by default). */
  sampleRate?: number;
  /** The agent's configured voice (a provider-specific speaker name). Omitted = the provider's default voice. */
  voice?: string;
}

/**
 * What a streaming TTS session reports. Delivery is in order and never after cancel() / close() or after onError.
 * Handlers must not throw (a throwing handler is isolated and logged, not propagated into the provider).
 */
export interface TtsStreamHandlers {
  /** Synthesized audio, ALREADY converted to raw 16-bit LE mono PCM at `TtsStreamOptions.sampleRate`. Strictly in order. */
  onAudio(pcm: Buffer): void;
  /** Everything passed to ONE sendText() call has been fully synthesized (and its audio delivered). One per sendText, in order. */
  onSegmentComplete(): void;
  /** The session is unusable and has been torn down. No further events except onClose. */
  onError(error: ProviderRequestError | ProviderConfigError): void;
  /** The session ended (after onError, close(), cancel() or the provider closing it). Exactly once. */
  onClose(): void;
}

export interface TtsStreamOptions extends ProviderCallOptions {
  languageCode?: string;
  /** Rate of the PCM handed to onAudio. Any conversion the provider needs is its own business. */
  sampleRate: number;
  /** The agent's configured voice; omitted = the provider's default voice. */
  voice?: string;
  /** Log-only identifiers. */
  agentId?: string;
  organizationId?: string;
}

export interface TtsStreamingSession {
  /** True until the session has errored, closed or been cancelled. */
  readonly open: boolean;
  /** Submits one piece of text (a sentence) for immediate synthesis. Returns false if the session is no longer usable. */
  sendText(text: string): boolean;
  /** Stops synthesis at once and releases the connection. Idempotent; no handler fires afterwards except onClose. */
  cancel(): void;
  /** Ends the session after what was sent has been synthesized (or immediately if nothing is outstanding). */
  close(): Promise<void>;
}

export interface ITextToSpeech {
  readonly name: string;
  readonly capabilities?: ProviderCapabilities;
  synthesize(text: string, opts?: TtsOptions): Promise<TtsResult>;
  /**
   * OPTIONAL streaming variant: open a session, feed it sentences as they become available, receive audio as it is
   * generated. Providers that cannot stream leave it undefined (`capabilities.streamingTts`). Resolves once the
   * session object exists (the connection may still be opening; text sent meanwhile is held, bounded).
   */
  startStreaming?(handlers: TtsStreamHandlers, opts: TtsStreamOptions): Promise<TtsStreamingSession>;
}
