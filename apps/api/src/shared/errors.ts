/**
 * Typed error classes used across adapters/services/routes so the HTTP
 * layer can respond with clear, user-safe messages instead of leaking
 * raw stack traces, while server-side logs still get full detail.
 */

/** A required provider credential/config value is missing or invalid. */
export class ProviderConfigError extends Error {
  constructor(public readonly provider: string, message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** The external provider itself returned an error, timed out, etc. */
export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderRequestError";
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
