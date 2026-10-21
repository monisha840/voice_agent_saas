/**
 * Helpers adapters use to turn what went wrong into a structured ProviderRequestError. They are provider-neutral so a
 * future adapter (any HTTP provider) classifies failures the same way, and they are deliberately conservative about
 * content: the message names the provider, the operation and the HTTP status, and NEVER the response body, the request
 * payload or any credential.
 */
import { ProviderRequestError, type ProviderFailureCategory } from "../../shared/errors.js";

/** HTTP status -> failure category. */
export function categoryForStatus(status: number): ProviderFailureCategory {
  if (status === 408 || status === 425) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "bad_response"; // a 2xx/3xx we could not use is reported by the adapter itself; this covers odd statuses
}

/** Retry-After as milliseconds (seconds or an HTTP date), or undefined. Capped so a hostile value cannot stall a call. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  return undefined;
}

/** A non-2xx response. Releases the body without reading it into anything we could log. */
export function httpFailure(provider: string, operation: string, response: Response): ProviderRequestError {
  void response.body?.cancel().catch(() => undefined);
  return new ProviderRequestError(provider, `${provider} ${operation} failed (HTTP ${response.status})`, undefined, {
    category: categoryForStatus(response.status),
    operation,
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

/** fetch itself rejected: no connection, DNS, TLS, reset, or an abort (timeout / cancellation). */
export function transportFailure(provider: string, operation: string, err: unknown): ProviderRequestError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError") {
    return new ProviderRequestError(provider, `${provider} ${operation} timed out`, err, { category: "timeout", operation });
  }
  if (name === "AbortError") {
    return new ProviderRequestError(provider, `${provider} ${operation} was cancelled`, err, { category: "cancelled", operation });
  }
  return new ProviderRequestError(provider, `Network error calling ${provider} ${operation}`, err, { category: "network", operation });
}

/** A 2xx whose body we could not use (not JSON, missing fields). */
export function badResponse(provider: string, operation: string, what: string, cause?: unknown): ProviderRequestError {
  return new ProviderRequestError(provider, `${provider} ${operation} returned an unusable response (${what})`, cause, {
    category: "bad_response",
    operation,
  });
}
