/**
 * Carries the current request's id through async code, so the structured logger can stamp every line written while
 * serving a request without each call site passing it along. The id comes from Fastify (see app.ts: an incoming
 * X-Request-Id is honored when it looks sane, otherwise one is generated).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage<{ requestId: string }>();

/** Accept a caller-supplied id only when it is short and plain, so it is safe to echo into logs and headers. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function resolveRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
