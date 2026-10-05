/**
 * Minimal structured logger wrapper. Kept intentionally simple for the
 * MVP (no Sentry/metrics per scope) — just consistent, leak-safe
 * server-side logging. Never pass secrets (API keys, tokens) as fields;
 * callers are responsible for redacting before logging, and the
 * `redact` helper below is provided for that purpose.
 */

type LogFields = Record<string, unknown>;

function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, fields?: LogFields) {
    console.log(JSON.stringify({ level: "info", time: timestamp(), message, ...fields }));
  },
  warn(message: string, fields?: LogFields) {
    console.warn(JSON.stringify({ level: "warn", time: timestamp(), message, ...fields }));
  },
  error(message: string, fields?: LogFields) {
    console.error(JSON.stringify({ level: "error", time: timestamp(), message, ...fields }));
  },
};

/** Redacts a secret-like string to its last 4 characters, for safe logging. */
export function redact(value: string | undefined | null): string {
  if (!value) return "(empty)";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
