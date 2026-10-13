/**
 * The reliability layer for AI provider calls: one small, provider-neutral function that gives any STT / LLM / TTS
 * call a bounded timeout, cancellation, bounded exponential-backoff retries for transient failures only, and an
 * optional circuit breaker. No queue and no shared state: it is a plain async wrapper.
 *
 * What it guarantees:
 *  - Every attempt is bounded by `timeoutMs`, and the whole call (attempts + waits) by `totalBudgetMs`.
 *  - Only transient failures are retried (see ProviderFailureCategory). Auth, invalid-request, configuration and
 *    internal errors are thrown immediately; so is cancellation.
 *  - Cancellation (the caller's AbortSignal) stops the in-flight attempt, any backoff wait, and further attempts.
 *  - If the circuit is open the call fails fast without touching the provider.
 *  - Errors that escape are always ProviderRequestError (or the caller's own ProviderConfigError), with a category,
 *    never the provider's raw body or credentials. Each failed attempt is logged with provider, operation, category,
 *    attempt, duration and the call id.
 *
 * It must only wrap operations that are safe to repeat. LLM chat, speech-to-text and text-to-speech are (they do not
 * change anything); executing a tool is not, and tools never go through here.
 */
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { CircuitBreaker } from "./circuit-breaker.js";

export interface RetryPolicy {
  /** Attempts including the first. 1 = never retry. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ReliableCallOptions {
  /** Provider name, e.g. "sarvam-105b". */
  provider: string;
  /** e.g. "llm.chat". */
  operation: string;
  /** Per-attempt bound. */
  timeoutMs: number;
  /** Bound on the whole call including retries. */
  totalBudgetMs: number;
  retry: RetryPolicy;
  breaker?: CircuitBreaker;
  /** The caller gives up: aborts the in-flight attempt and stops retrying. */
  signal?: AbortSignal;
  /** For logs only. */
  callId?: string;
  /**
   * Extra veto on retrying a transient failure, asked after every failed attempt. A streaming call returns false once
   * it has delivered anything to the caller: a half-delivered generation must never be repeated.
   */
  canRetry?: () => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const timeoutReason = () => new DOMException("provider call timed out", "TimeoutError");
const cancelReason = () => new DOMException("provider call cancelled", "AbortError");

function cancelledError(provider: string, operation: string): ProviderRequestError {
  return new ProviderRequestError(provider, `${provider} ${operation} was cancelled`, undefined, { category: "cancelled", operation });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with jitter: base * 2^(attempt-1), capped, then randomised into [50%, 100%]. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

/** Turns anything an attempt can throw into a ProviderRequestError (or lets the caller's ProviderConfigError through). */
function normalize(raw: unknown, o: ReliableCallOptions, flags: { timedOut: boolean; cancelled: boolean }): ProviderRequestError | ProviderConfigError {
  if (raw instanceof ProviderConfigError) return raw;
  if (flags.cancelled) return cancelledError(o.provider, o.operation);
  if (flags.timedOut) {
    return new ProviderRequestError(o.provider, `${o.provider} ${o.operation} timed out after ${o.timeoutMs}ms`, raw, {
      category: "timeout",
      operation: o.operation,
    });
  }
  if (raw instanceof ProviderRequestError) return raw;
  const name = (raw as { name?: string } | null)?.name;
  if (name === "TimeoutError") {
    return new ProviderRequestError(o.provider, `${o.provider} ${o.operation} timed out`, raw, { category: "timeout", operation: o.operation });
  }
  if (name === "AbortError") return cancelledError(o.provider, o.operation);
  // Our own bug or an unclassified failure: permanent, and its message is not repeated (it could contain anything).
  return new ProviderRequestError(o.provider, `${o.provider} ${o.operation} failed unexpectedly`, raw, { category: "internal", operation: o.operation });
}

/** One attempt, bounded by the timeout and by the caller's signal even if `fn` ignores its signal. */
async function runAttempt<T>(o: ReliableCallOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const flags = { timedOut: false, cancelled: false };
  let onCallerAbort: (() => void) | undefined;
  const timer = setTimeout(() => {
    flags.timedOut = true;
    controller.abort(timeoutReason());
  }, o.timeoutMs);
  if (o.signal) {
    onCallerAbort = () => {
      flags.cancelled = true;
      controller.abort(cancelReason());
    };
    o.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  aborted.catch(() => undefined); // the race below consumes it; avoid an unhandled rejection when fn wins
  try {
    return await Promise.race([fn(controller.signal), aborted]);
  } catch (raw) {
    throw normalize(raw, o, flags);
  } finally {
    clearTimeout(timer);
    if (o.signal && onCallerAbort) o.signal.removeEventListener("abort", onCallerAbort);
  }
}

export async function callWithReliability<T>(o: ReliableCallOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const started = now();
  const maxAttempts = Math.max(1, o.retry.maxAttempts);

  for (let attempt = 1; ; attempt++) {
    if (o.signal?.aborted) throw cancelledError(o.provider, o.operation);
    let ticket: Awaited<ReturnType<CircuitBreaker["acquire"]>> | undefined;
    try {
      ticket = o.breaker ? await o.breaker.acquire(o.operation) : undefined;
    } catch (open) {
      // The circuit is open: fail fast, without retrying and without touching the provider.
      logger.warn("provider call refused: circuit open", { provider: o.provider, operation: o.operation, attempt, callId: o.callId });
      throw open;
    }
    const attemptStart = now();
    try {
      const value = await runAttempt(o, fn);
      await ticket?.success();
      if (attempt > 1) {
        logger.info("provider call recovered after retry", { provider: o.provider, operation: o.operation, attempt, durationMs: now() - started, callId: o.callId });
      }
      return value;
    } catch (err) {
      const e = err as ProviderRequestError | ProviderConfigError;
      const category = e.category;
      // Health accounting for the circuit breaker: only failures that say the provider is unwell count.
      if (category === "timeout" || category === "network" || category === "server" || category === "bad_response") await ticket?.failure();
      else await ticket?.release();

      const transient = e.transient && (o.canRetry ? o.canRetry() : true);
      let retryInMs: number | undefined;
      if (transient && attempt < maxAttempts) {
        const hint = e instanceof ProviderRequestError ? e.retryAfterMs : undefined;
        const delay = Math.min(o.retry.maxDelayMs, hint ?? backoffDelayMs(attempt, o.retry, o.random));
        // Retry only if the wait plus a fresh attempt still fits the total budget.
        if (now() - started + delay < o.totalBudgetMs) retryInMs = delay;
      }

      logger[category === "cancelled" ? "info" : "warn"]("provider call failed", {
        provider: o.provider,
        operation: o.operation,
        category,
        status: e instanceof ProviderRequestError ? e.status : undefined,
        attempt,
        maxAttempts,
        durationMs: now() - attemptStart,
        willRetry: retryInMs !== undefined,
        retryInMs,
        callId: o.callId,
      });

      if (retryInMs === undefined) {
        if (e instanceof ProviderRequestError) e.attempts = attempt;
        throw e;
      }
      try {
        await sleep(retryInMs, o.signal);
      } catch {
        throw cancelledError(o.provider, o.operation); // cancelled while waiting to retry
      }
    }
  }
}
