/**
 * ITelephonyProvider — the only contract the `calls` module is allowed
 * to depend on. No module outside `adapters/telephony/` may import
 * Exotel-specific types or call Exotel's API directly.
 */

export interface InitiateCallParams {
  /** E.164 phone number to call. */
  toNumber: string;
  /** Our internal calls.id, so callbacks can be correlated back to it. */
  internalCallId: string;
}

export interface InitiateCallResult {
  /** The provider's own call identifier (e.g. Exotel's Call Sid). */
  providerCallId: string;
  /** Provider's reported initial status, in our own CallStatus shape. */
  status: "initiating" | "ringing";
}

export type TelephonyStatusCallbackPayload = Record<string, unknown>;

export interface ParsedStatusCallback {
  providerCallId: string;
  status: "ringing" | "in_progress" | "completed" | "failed";
  /** Present once the call has actually ended. */
  durationSeconds?: number;
  recordingUrl?: string;
}

export interface ITelephonyProvider {
  readonly name: string;

  /**
   * Places an outbound call. Must return as soon as the provider has
   * accepted the request — must NOT block until the call completes.
   *
   * Throws ProviderConfigError if required credentials are missing.
   * Throws ProviderRequestError if the provider rejects/fails the request.
   */
  initiateCall(params: InitiateCallParams): Promise<InitiateCallResult>;

  /**
   * Parses a provider-specific status callback payload into our
   * normalized shape. Pure/no I/O — callers persist the result.
   */
  parseStatusCallback(payload: TelephonyStatusCallbackPayload): ParsedStatusCallback;
}
