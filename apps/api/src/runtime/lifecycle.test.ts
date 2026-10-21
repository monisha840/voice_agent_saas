/**
 * Graceful shutdown: draining refuses new calls, live calls are waited for (not cut off), stragglers are closed
 * politely only after the timeout, and background work finishes before the process goes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Lifecycle } from "./lifecycle.js";
import { gracefulShutdown } from "./shutdown.js";
import { lifecycle } from "./lifecycle.js";
import { ServiceUnavailableError } from "../shared/errors.js";

describe("Lifecycle", () => {
  let lc: Lifecycle;
  beforeEach(() => {
    lc = new Lifecycle();
  });

  it("accepts calls until draining starts, then refuses with SHUTTING_DOWN", () => {
    expect(() => lc.assertAcceptingCalls()).not.toThrow();
    lc.beginDrain();
    expect(lc.isDraining()).toBe(true);
    try {
      lc.assertAcceptingCalls();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      expect((err as ServiceUnavailableError).code).toBe("SHUTTING_DOWN");
      expect((err as ServiceUnavailableError).statusCode).toBe(503);
    }
  });

  it("drain waits for a live call to end by itself and does NOT close it", async () => {
    const close = vi.fn();
    const unregister = lc.registerSession({ callId: "c1", close });
    let drained = false;
    const draining = lc.drain({ timeoutMs: 5_000 }).then((r) => {
      drained = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(drained).toBe(false); // still waiting: the call is live
    expect(close).not.toHaveBeenCalled();
    unregister(); // the call ends on its own
    const result = await draining;
    expect(result.forcedClosed).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("after the drain timeout, closes the remaining calls with 1001 (going away)", async () => {
    const unregisters: Array<() => void> = [];
    const close = vi.fn((_code: number, _reason: string) => {
      // a closing socket unregisters itself
      unregisters.forEach((u) => u());
    });
    unregisters.push(lc.registerSession({ callId: "slow", close }));
    const result = await lc.drain({ timeoutMs: 50 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0][0]).toBe(1001);
    expect(result.forcedClosed).toBe(1);
  });

  it("waits for tracked background tasks (post-call finalization)", async () => {
    let finished = false;
    lc.trackTask(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          finished = true;
          resolve();
        }, 60),
      ),
    );
    await lc.drain({ timeoutMs: 1_000 });
    expect(finished).toBe(true);
  });

  it("a rejecting tracked task does not break the drain", async () => {
    lc.trackTask(Promise.reject(new Error("finalization failed")).catch(() => undefined));
    await expect(lc.drain({ timeoutMs: 1_000 })).resolves.toEqual({ forcedClosed: 0 });
  });

  it("counts live calls", () => {
    const u1 = lc.registerSession({ callId: "a", close: () => undefined });
    lc.registerSession({ callId: "b", close: () => undefined });
    expect(lc.liveCallCount()).toBe(2);
    u1();
    expect(lc.liveCallCount()).toBe(1);
  });
});

describe("gracefulShutdown sequence", () => {
  beforeEach(() => lifecycle.reset());

  it("drains, then closes the server, then the database, in that order, without cutting off a live call", async () => {
    const order: string[] = [];
    const close = vi.fn();
    const unregister = lifecycle.registerSession({ callId: "live", close });

    const shutdown = gracefulShutdown("SIGTERM", {
      drainTimeoutMs: 5_000,
      stopBackground: () => order.push("stop-background"),
      closeServer: async () => void order.push("close-server"),
      closeDatabase: async () => void order.push("close-database"),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(lifecycle.isDraining()).toBe(true); // readiness is red, new calls refused...
    expect(order).toEqual(["stop-background"]); // ...but the server is still up while the call runs
    expect(close).not.toHaveBeenCalled();

    unregister(); // the live call finishes normally
    await shutdown;
    expect(order).toEqual(["stop-background", "close-server", "close-database"]);
    expect(close).not.toHaveBeenCalled();
    lifecycle.reset();
  });
});
