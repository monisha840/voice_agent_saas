/**
 * The provider reliability layer: timeout, retry of transient failures only, bounded backoff, cancellation, retry
 * exhaustion, structured errors that leak nothing, and the circuit breaker wired in. Time is injected where it matters
 * so nothing here sleeps for real except the (tiny) timeouts under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderConfigError, ProviderRequestError, CircuitOpenError, type ProviderFailureCategory } from "../../shared/errors.js";
import { backoffDelayMs, callWithReliability, type ReliableCallOptions } from "./reliability.js";
import { InMemoryCircuitBreaker } from "./circuit-breaker.js";

const failure = (category: ProviderFailureCategory, extra: { status?: number; retryAfterMs?: number } = {}) =>
  new ProviderRequestError("test-provider", `test-provider op failed (${category})`, new Error("RAW: sk-live-SECRET and {\"prompt\":\"private\"}"), {
    category,
    operation: "test.op",
    ...extra,
  });

/** Options with instant sleeps recorded for assertions. */
function opts(overrides: Partial<ReliableCallOptions> = {}) {
  const sleeps: number[] = [];
  const o: ReliableCallOptions = {
    provider: "test-provider",
    operation: "test.op",
    timeoutMs: 1_000,
    totalBudgetMs: 30_000,
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1, // no jitter: delays are exactly base * 2^(n-1)
    ...overrides,
  };
  return { o, sleeps };
}

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "warn").mockImplementation((l: string) => void lines.push(l));
  vi.spyOn(console, "info").mockImplementation((l: string) => void lines.push(l));
  vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
});
afterEach(() => vi.restoreAllMocks());

describe("success and transient retry", () => {
  it("a call that works is made once and returns its value", async () => {
    const fn = vi.fn(async () => "ok");
    const { o, sleeps } = opts();
    await expect(callWithReliability(o, fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("retries transient failures with bounded exponential backoff, then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw failure("server", { status: 503 });
      return "recovered";
    });
    const { o, sleeps } = opts();
    await expect(callWithReliability(o, fn)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // base * 2^(attempt-1)
  });

  it.each(["timeout", "network", "server", "bad_response", "rate_limited"] as const)("%s is retried", async (category) => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n === 1) throw failure(category);
      return "ok";
    });
    await expect(callWithReliability(opts().o, fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("the backoff is capped at maxDelayMs and never exceeds it with jitter", () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 500 };
    for (let attempt = 1; attempt <= 10; attempt++) {
      for (const r of [0, 0.5, 1]) {
        const d = backoffDelayMs(attempt, policy, () => r);
        expect(d).toBeLessThanOrEqual(500);
        expect(d).toBeGreaterThanOrEqual(Math.round(Math.min(500, 100 * 2 ** (attempt - 1)) * 0.5));
      }
    }
  });

  it("honours the provider's Retry-After hint, but never waits longer than maxDelayMs", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n === 1) throw failure("rate_limited", { status: 429, retryAfterMs: 400 });
      if (n === 2) throw failure("rate_limited", { status: 429, retryAfterMs: 60_000 });
      return "ok";
    });
    const { o, sleeps } = opts();
    await expect(callWithReliability(o, fn)).resolves.toBe("ok");
    expect(sleeps).toEqual([400, 1_000]);
  });
});

describe("permanent failures are never retried", () => {
  it.each(["auth", "invalid_request", "internal"] as const)("%s: one attempt, thrown as-is", async (category) => {
    const err = failure(category);
    const fn = vi.fn(async () => {
      throw err;
    });
    const { o, sleeps } = opts();
    await expect(callWithReliability(o, fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("a missing-configuration error passes through untouched and is not retried", async () => {
    const err = new ProviderConfigError("test-provider", "TEST_KEY is not configured");
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(callWithReliability(opts().o, fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("an unexpected exception (our own bug) becomes an 'internal' error, is not retried, and its message is not repeated", async () => {
    const fn = vi.fn(async () => {
      throw new Error("TypeError: cannot read apiKey sk-live-SECRET");
    });
    const e = (await callWithReliability(opts().o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e).toBeInstanceOf(ProviderRequestError);
    expect(e.category).toBe("internal");
    expect(e.transient).toBe(false);
    expect(e.message).not.toContain("sk-live-SECRET");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("retry exhaustion", () => {
  it("gives up after maxAttempts and reports the last failure with the attempt count", async () => {
    const fn = vi.fn(async () => {
      throw failure("server", { status: 502 });
    });
    const { o, sleeps } = opts();
    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(e.category).toBe("server");
    expect(e.transient).toBe(true);
    expect(e.attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("maxAttempts 1 means no retries at all", async () => {
    const fn = vi.fn(async () => {
      throw failure("server");
    });
    await expect(callWithReliability(opts({ retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }).o, fn)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the next wait would blow the total budget", async () => {
    let clock = 0;
    const fn = vi.fn(async () => {
      clock += 900; // each attempt "takes" 900 ms
      throw failure("timeout");
    });
    const { o } = opts({ now: () => clock, totalBudgetMs: 1_000, retry: { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 1_000 } });
    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(fn).toHaveBeenCalledTimes(1); // 900 elapsed + 200 wait > 1000 budget
    expect(e.attempts).toBe(1);
  });
});

describe("timeout", () => {
  it("an attempt that never answers is cut off at timeoutMs, aborted, and reported as a timeout", async () => {
    let seen: AbortSignal | undefined;
    const fn = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => undefined); // hangs, ignoring the signal entirely
    });
    const { o } = opts({ timeoutMs: 40, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const started = Date.now();
    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(e.category).toBe("timeout");
    expect(e.transient).toBe(true);
    expect(seen?.aborted).toBe(true); // a cooperative provider was told to stop
  });

  it("a timeout is retried, and a later attempt can succeed", async () => {
    let n = 0;
    const fn = vi.fn((signal: AbortSignal) => {
      if (++n === 1) return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return Promise.resolve("second try");
    });
    await expect(callWithReliability(opts({ timeoutMs: 30 }).o, fn)).resolves.toBe("second try");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("cancellation", () => {
  it("aborting while a request is in flight stops it, rejects as 'cancelled', and is not retried", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const fn = vi.fn((signal: AbortSignal) => {
      providerSignal = signal;
      return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const pending = callWithReliability(opts({ signal: controller.signal }).o, fn).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const e = (await pending) as ProviderRequestError;
    expect(e.category).toBe("cancelled");
    expect(e.transient).toBe(false);
    expect(providerSignal?.aborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("aborting while waiting to retry stops the wait and makes no further attempt", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw failure("server");
    });
    const { o } = opts({
      signal: controller.signal,
      sleep: (_ms, signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          controller.abort(); // the call ends during the backoff wait
        }),
    });
    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e.category).toBe("cancelled");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("an already-cancelled call is never attempted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "never");
    const e = (await callWithReliability(opts({ signal: controller.signal }).o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e.category).toBe("cancelled");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns on cancellation even if the provider ignores its signal", async () => {
    const controller = new AbortController();
    const fn = vi.fn(() => new Promise<string>(() => undefined));
    const pending = callWithReliability(opts({ signal: controller.signal, timeoutMs: 60_000 }).o, fn).catch((x: unknown) => x);
    setTimeout(() => controller.abort(), 20);
    expect(((await pending) as ProviderRequestError).category).toBe("cancelled");
  });
});

describe("logging and error content", () => {
  it("every failed attempt is logged with provider, operation, category, attempt, duration and call id; no secrets or payloads", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 2) throw failure("server", { status: 503 });
      return "ok";
    });
    await callWithReliability(opts({ callId: "call-123" }).o, fn);
    const entry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === "provider call failed")!;
    expect(entry).toMatchObject({
      provider: "test-provider",
      operation: "test.op",
      category: "server",
      status: 503,
      attempt: 1,
      maxAttempts: 3,
      willRetry: true,
      callId: "call-123",
    });
    expect(typeof entry.durationMs).toBe("number");
    expect(lines.join("\n")).not.toMatch(/sk-live-SECRET|private/);
  });

  it("the error's log fields carry no message body, payload or cause", () => {
    const e = failure("server", { status: 500 });
    const fields = JSON.stringify(e.toLogFields());
    expect(fields).toContain('"category":"server"');
    expect(fields).not.toMatch(/sk-live-SECRET|private|RAW/);
    expect(e.message).not.toMatch(/sk-live-SECRET|private|RAW/);
  });
});

describe("with a circuit breaker", () => {
  it("provider-health failures open the circuit; further calls fail fast WITHOUT touching the provider", async () => {
    const breaker = new InMemoryCircuitBreaker("test-provider", { failureThreshold: 2, cooldownMs: 10_000 });
    const fn = vi.fn(async () => {
      throw failure("server");
    });
    const { o } = opts({ breaker, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    await callWithReliability(o, fn).catch(() => undefined);
    await callWithReliability(o, fn).catch(() => undefined);
    expect(fn).toHaveBeenCalledTimes(2);
    expect((await breaker.snapshot()).state).toBe("open");

    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e).toBeInstanceOf(CircuitOpenError);
    expect(e.category).toBe("circuit_open");
    expect(e.transient).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2); // not called again
  });

  it("an open circuit is not retried within one call", async () => {
    const breaker = new InMemoryCircuitBreaker("test-provider", { failureThreshold: 1, cooldownMs: 10_000 });
    const fn = vi.fn(async () => {
      throw failure("server");
    });
    const { o, sleeps } = opts({ breaker });
    const e = (await callWithReliability(o, fn).catch((x: unknown) => x)) as ProviderRequestError;
    // attempt 1 fails and opens the circuit; the retry is refused at once rather than being attempted
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e).toBeInstanceOf(CircuitOpenError);
    expect(sleeps).toHaveLength(1);
  });

  it("failures that say nothing about provider health (auth, bad request, rate limit, cancellation) never open it", async () => {
    const breaker = new InMemoryCircuitBreaker("test-provider", { failureThreshold: 2, cooldownMs: 10_000 });
    const { o } = opts({ breaker, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    for (const category of ["auth", "invalid_request", "rate_limited", "internal"] as const) {
      for (let i = 0; i < 3; i++) {
        await callWithReliability(o, async () => {
          throw failure(category);
        }).catch(() => undefined);
      }
    }
    expect((await breaker.snapshot()).state).toBe("closed");
  });
});
