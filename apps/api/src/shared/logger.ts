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

const SECRET_KEY = /pass(word)?|token|secret|hash|authorization|cookie|api[-_]?key|credential/i;
const MAX_DEPTH = 6;

/** Masks secrets that appear inside free text (URLs, header dumps, error messages). */
export function scrubString(value: string): string {
  return value
    .replace(/([?&](?:token|access_token|api[-_]?key|password)=)[^&\s"']*/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]")
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
