/**
 * The circuit breaker state machine: closed -> open -> half-open -> closed, on an injected clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitOpenError } from "../../shared/errors.js";
import { getCircuitBreaker, InMemoryCircuitBreaker, resetCircuitBreakers } from "./circuit-breaker.js";

let clock = 0;
const make = (over: { failureThreshold?: number; cooldownMs?: number; halfOpenMaxProbes?: number } = {}) =>
  new InMemoryCircuitBreaker("p", { failureThreshold: 3, cooldownMs: 1_000, now: () => clock, ...over });

beforeEach(() => {
  clock = 10_000;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetCircuitBreakers();
});

async function fail(b: InMemoryCircuitBreaker, times = 1) {
  for (let i = 0; i < times; i++) await (await b.acquire()).failure();
}

describe("closed", () => {
  it("starts closed and lets calls through", async () => {
    const b = make();
    expect((await b.snapshot()).state).toBe("closed");
    await expect(b.acquire()).resolves.toBeTruthy();
  });

  it("opens after failureThreshold CONSECUTIVE failures", async () => {
    const b = make();
    await fail(b, 2);
    expect((await b.snapshot()).state).toBe("closed");
    await fail(b, 1);
    expect((await b.snapshot()).state).toBe("open");
  });

  it("a success resets the count, so scattered failures never open it", async () => {
    const b = make();
    for (let i = 0; i < 10; i++) {
      await fail(b, 2);
      await (await b.acquire()).success();
    }
    expect((await b.snapshot()).state).toBe("closed");
  });

  it("a released call (cancelled, auth, ...) counts neither way", async () => {
    const b = make();
    await fail(b, 2);
    await (await b.acquire()).release();
    expect((await b.snapshot()).consecutiveFailures).toBe(2);
  });
});

describe("open", () => {
  it("fails fast with CircuitOpenError and says when to try again", async () => {
    const b = make();
    await fail(b, 3);
    clock += 400;
    const err = (await b.acquire("llm.chat").catch((e: unknown) => e)) as CircuitOpenError;
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.category).toBe("circuit_open");
    expect(err.operation).toBe("llm.chat");
    expect(err.retryAfterMs).toBe(600);
  });

  it("stays open for the whole cooldown", async () => {
    const b = make();
    await fail(b, 3);
    clock += 999;
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe("half-open and recovery", () => {
  it("after the cooldown exactly one probe is let through; other callers still fail fast", async () => {
    const b = make();
    await fail(b, 3);
    clock += 1_000;
    const probe = await b.acquire();
    expect((await b.snapshot()).state).toBe("half_open");
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);
    await probe.release();
  });

  it("a successful probe closes the circuit and normal traffic resumes", async () => {
    const b = make();
    await fail(b, 3);
    clock += 1_000;
    await (await b.acquire()).success();
    expect((await b.snapshot()).state).toBe("closed");
    expect((await b.snapshot()).consecutiveFailures).toBe(0);
    await expect(b.acquire()).resolves.toBeTruthy();
    await expect(b.acquire()).resolves.toBeTruthy();
  });

  it("a failed probe re-opens the circuit and restarts the cooldown", async () => {
    const b = make();
    await fail(b, 3);
    clock += 1_000;
    await (await b.acquire()).failure();
    expect((await b.snapshot()).state).toBe("open");
    clock += 999;
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError); // cooldown restarted from the failed probe
    clock += 1;
    await expect(b.acquire()).resolves.toBeTruthy(); // next probe
  });

  it("a probe that is released (cancelled) frees the slot for another probe", async () => {
    const b = make();
    await fail(b, 3);
    clock += 1_000;
    await (await b.acquire()).release();
    expect((await b.snapshot()).state).toBe("half_open");
    await expect(b.acquire()).resolves.toBeTruthy();
  });

  it("halfOpenMaxProbes allows several probes at once", async () => {
    const b = make({ halfOpenMaxProbes: 2 });
    await fail(b, 3);
    clock += 1_000;
    await b.acquire();
    await b.acquire();
    await expect(b.acquire()).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe("safety", () => {
  it("a ticket settles at most once", async () => {
    const b = make({ failureThreshold: 2 });
    const t = await b.acquire();
    await t.failure();
    await t.failure();
    await t.failure();
    expect((await b.snapshot()).consecutiveFailures).toBe(1);
  });

  it("a call that was admitted before the circuit opened cannot change the new state when it finishes", async () => {
    const b = make({ failureThreshold: 1 });
    const slow = await b.acquire(); // started while closed
    await fail(b, 1); // another call opens the circuit meanwhile
    expect((await b.snapshot()).state).toBe("open");
    await slow.success(); // the slow call finishes OK afterwards
    expect((await b.snapshot()).state).toBe("open"); // it does not close the circuit
  });
});

describe("registry", () => {
  it("one breaker per provider, created once; providers are isolated from each other", async () => {
    const stt = getCircuitBreaker("sarvam-saaras", () => make({ failureThreshold: 1 }));
    const llm = getCircuitBreaker("sarvam-105b", () => make({ failureThreshold: 1 }));
    expect(getCircuitBreaker("sarvam-saaras", () => make())).toBe(stt);
    await (await stt.acquire()).failure();
    expect((await stt.snapshot()).state).toBe("open");
    expect((await llm.snapshot()).state).toBe("closed"); // an STT outage does not stop the LLM
  });
});
