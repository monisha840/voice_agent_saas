/**
 * Minimal structured logger wrapper. Kept intentionally simple for the
 * MVP (no Sentry/metrics per scope) — just consistent, leak-safe
 * server-side logging. Fields are scrubbed defensively before printing:
 * secret-looking keys are replaced at any depth, and secrets embedded in
 * strings (?token=, Authorization/Bearer/Basic values, session cookies) are
 * masked. Callers should still avoid passing secrets at all.
 */

import { currentRequestId } from "../runtime/request-context.js";

type LogFields = Record<string, unknown>;

const SECRET_KEY = /pass(word)?|token|secret|hash|authorization|cookie|api[-_]?key|credential|grant(?!ed)|^st$|^g$/i;
const MAX_DEPTH = 6;

/** Query keys whose values are credentials. Compared after percent-decoding, case-insensitively. */
const SECRET_QUERY_KEYS = new Set(["token", "access_token", "api_key", "api-key", "apikey", "password", "secret", "st", "g"]);

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Masks the value of every credential-named query parameter, including percent-encoded key spellings
 * (`t%6Fken=` is `token` to the server's query parser, so it must be one to the log scrubber).
 */
export function maskQueryCredentials(value: string): string {
  return value.replace(/([?&])([^=&\s"'#]+)=([^&\s"'#]*)/g, (m, sep: string, key: string) =>
    SECRET_QUERY_KEYS.has(decodedKey(key)) ? `${sep}${key}=[redacted]` : m,
  );
}

/** Masks secrets that appear inside free text (URLs, header dumps, error messages). */
export function scrubString(value: string): string {
  return maskQueryCredentials(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#"']+@/gi, "$1[redacted]@") // user:password@host (Basic credentials in a URL)
    .replace(/\b(va_session|session|sid)=[^;\s"']+/gi, "$1=[redacted]");
}

/** Deep copy with secret-keyed values replaced and strings scrubbed. Exported for tests. */
export function scrubFields(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => scrubFields(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrubFields(v, depth + 1);
  }
  return out;
}

function timestamp() {
  return new Date().toISOString();
}

function line(level: string, message: string, fields?: LogFields) {
  const requestId = currentRequestId();
  // Lines written while serving a request carry its id (runtime/request-context.ts), so one request can be followed.
  return JSON.stringify({
    level,
    time: timestamp(),
    message: scrubString(message),
    ...(requestId ? { requestId } : {}),
    ...(scrubFields(fields ?? {}) as LogFields),
  });
}

export const logger = {
  info(message: string, fields?: LogFields) {
    console.log(line("info", message, fields));
  },
  warn(message: string, fields?: LogFields) {
    console.warn(line("warn", message, fields));
  },
  error(message: string, fields?: LogFields) {
    console.error(line("error", message, fields));
  },
};

/** Redacts a secret-like string to its last 4 characters, for safe logging. */
export function redact(value: string | undefined | null): string {
  if (!value) return "(empty)";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
