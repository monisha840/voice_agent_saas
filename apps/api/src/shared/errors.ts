/**
 * Typed error classes used across adapters/services/routes so the HTTP
 * layer can respond with clear, user-safe messages instead of leaking
 * raw stack traces, while server-side logs still get full detail.
 */

/**
 * Why a provider call failed, in provider-neutral terms. Adapters map their own errors onto these; the reliability
 * layer (adapters/ai/reliability.ts) decides what to do from the category alone:
 *
 *   transient (worth retrying, and a sign the provider may be unhealthy):
 *     timeout       the call did not finish in time
 *     network       connection-level failure
 *     server        the provider answered 5xx
 *     bad_response  a 2xx we could not use (malformed body)
 *     rate_limited  429; retried, but not a health signal for the circuit breaker
 *   permanent (retrying cannot help):
 *     auth             credentials rejected (401/403)
 *     invalid_request  the provider rejected our request (400/404/422...)
 *     config           a required setting is missing (see ProviderConfigError)
 *     internal         a bug on our side
 *   neither:
 *     cancelled        the caller gave up (e.g. the call ended)
 *     circuit_open     failed fast because the provider is marked unhealthy
 */
export type ProviderFailureCategory =
  | "timeout"
  | "network"
  | "server"
  | "bad_response"
  | "rate_limited"
  | "auth"
  | "invalid_request"
  | "config"
  | "internal"
  | "cancelled"
  | "circuit_open";

const TRANSIENT_CATEGORIES: ReadonlySet<ProviderFailureCategory> = new Set(["timeout", "network", "server", "bad_response", "rate_limited"]);

export function isTransientCategory(category: ProviderFailureCategory): boolean {
  return TRANSIENT_CATEGORIES.has(category);
}

/** A required provider credential/config value is missing or invalid. */
export class ProviderConfigError extends Error {
  readonly category = "config" as const;
  readonly transient = false;
  constructor(public readonly provider: string, message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface ProviderErrorDetails {
  category?: ProviderFailureCategory;
  /** What was being done, e.g. "llm.chat", "stt.transcribe", "tts.synthesize". */
  operation?: string;
  /** HTTP status, when there was one. */
  status?: number;
  /** The provider's own hint for when to try again (Retry-After), in milliseconds. */
  retryAfterMs?: number;
}

/**
 * The external provider itself returned an error, timed out, etc.
 *
 * Structured on purpose: `category` / `transient` drive retry and circuit-breaker decisions, and `toLogFields()` is the
 * ONLY thing meant to be logged. The message is written by us and never contains the provider's response body,
 * request payload or credentials; the underlying `cause` is kept for debugging but must not be logged or shown.
 */
export class ProviderRequestError extends Error {
  readonly category: ProviderFailureCategory;
  readonly operation?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** How many attempts were made before giving up (set by the reliability layer). */
  attempts?: number;
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.category = details.category ?? "internal";
    this.operation = details.operation;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  get transient(): boolean {
    return isTransientCategory(this.category);
  }

  /** Safe to log: no message body, payload, credentials or cause. */
  toLogFields(): Record<string, unknown> {
    return {
      provider: this.provider,
      operation: this.operation,
      category: this.category,
      transient: this.transient,
      status: this.status,
      attempts: this.attempts,
    };
  }
}

/** The provider is marked unhealthy; the call failed fast without being attempted. */
export class CircuitOpenError extends ProviderRequestError {
  constructor(provider: string, operation: string | undefined, retryAfterMs: number) {
    super(provider, `${provider} is temporarily unavailable (circuit open); not attempted`, undefined, {
      category: "circuit_open",
      operation,
      retryAfterMs,
    });
    this.name = "CircuitOpenError";
  }
}

/** The caller asked for something that doesn't exist (404-shaped). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The caller's input/state makes the operation invalid (400-shaped). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** No valid login (401-shaped). */
export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Logged in, but not allowed to do this (403-shaped). */
export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do this") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The request conflicts with current state, e.g. a duplicate (409-shaped). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A per-organization limit or quota stops this request (429-shaped). `code` tells clients which one. */
export class LimitExceededError extends Error {
  readonly statusCode = 429;
  constructor(
    message: string,
    public readonly code: "CONCURRENT_CALL_LIMIT" | "DAILY_CALL_QUOTA" | "MONTHLY_CALL_SECONDS_QUOTA",
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LimitExceededError";
  }
}

/** The service cannot take this request right now, e.g. it is shutting down (503-shaped). */
export class ServiceUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(
    message: string,
    public readonly code: "SHUTTING_DOWN" | "NOT_READY" = "NOT_READY",
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
