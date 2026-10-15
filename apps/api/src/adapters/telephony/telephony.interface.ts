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
  /**
   * The organization that owns the call. Bound into the per-call media-stream token, so the stream can only ever
   * attach to this call in this organization. Required by providers that dial with a stream URL.
   */
  organizationId?: string;
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
  status: "ringing" | "in_progress" | "completed" | "busy" | "no_answer" | "failed";
  /** Present once the call has actually ended. */
  durationSeconds?: number;
  recordingUrl?: string;
}

/**
 * How the deployment's telephony provider is set up, for the number-management screen. Setting NAMES only, never
 * values: nothing here may contain a credential.
 */
export interface ProviderSetupStatus {
  provider: string;
  /** True for the development provider: no real call can arrive or be placed. */
  simulated: boolean;
  /** Every required setting is present and valid. */
  configured: boolean;
  /** Names of required settings that are missing. */
  missing: string[];
  /** Other configuration problems, in words. */
  problems: string[];
  /** Whether the provider can confirm a number exists on the account (checkNumber). */
  numberCheckSupported: boolean;
}

/** What the provider says about one of our numbers. Only this number's own fields: never the account's other numbers. */
export interface ProviderNumberCheck {
  status: "verified" | "not_found" | "error" | "unsupported";
  /** Customer-readable explanation; never contains credentials or raw provider responses. */
  detail: string;
  /** The provider failed in a way that may pass on a later attempt (timeout, rate limit, provider error). */
  retryable?: boolean;
  voiceCapable?: boolean;
  /** The number has an incoming-call destination (flow / app) set at the provider. */
  voiceDestinationSet?: boolean;
}

export interface ITelephonyProvider {
  readonly name: string;

  /** Configuration status for display. Optional: providers without it are shown as "status unknown". */
  describeSetup?(): ProviderSetupStatus;

  /**
   * Read-only check that `phoneNumber` (E.164) exists on the provider account. Must not throw for provider failures:
   * they are returned as status "error" with a readable detail. Optional.
   */
  checkNumber?(phoneNumber: string): Promise<ProviderNumberCheck>;

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
