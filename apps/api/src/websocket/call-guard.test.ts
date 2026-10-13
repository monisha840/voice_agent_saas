/**
 * The per-call time guards (max duration, silence timeout) in isolation, on a fake clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CallGuard, type CallGuardOptions } from "./call-guard.js";

function makeGuard(overrides: Partial<CallGuardOptions> = {}) {
  const events: string[] = [];
  const guard = new CallGuard({
    maxDurationMs: 60_000,
    silenceTimeoutMs: 5_000,
    maxReprompts: 1,
    onReprompt: () => void events.push("reprompt"),
    onSilenceEnd: () => void events.push("silence_end"),
    onMaxDuration: () => void events.push("max_duration"),
    ...overrides,
  });
  return { guard, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("maximum call duration", () => {
  it("fires once, when the call has run for the limit", async () => {
    const { guard, events } = makeGuard({ silenceTimeoutMs: 0 });
    guard.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(events).toEqual(["max_duration"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toEqual(["max_duration"]);
  });

  it("0 means no cap", async () => {
    const { guard, events } = makeGuard({ maxDurationMs: 0, silenceTimeoutMs: 0 });
    guard.start();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(events).toEqual([]);
  });

  it("stop() cancels it", async () => {
    const { guard, events } = makeGuard();
    guard.start();
    guard.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(events).toEqual([]);
  });
});

describe("silence timeout", () => {
  it("reprompts once, then ends the call after another silent stretch", async () => {
    const { guard, events } = makeGuard();
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(events).toEqual(["reprompt"]);
    // The handler speaks the reprompt, then waits again.
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(events).toEqual(["reprompt", "silence_end"]);
  });

  it("with zero reprompts allowed, ends the call at the first silence", async () => {
    const { guard, events } = makeGuard({ maxReprompts: 0 });
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(events).toEqual(["silence_end"]);
  });

  it("is not running until armed, and disarming stops it (the agent is speaking or thinking)", async () => {
    const { guard, events } = makeGuard();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(events).toEqual([]);
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(4_000);
    guard.disarmSilence();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([]);
  });

  it("hearing the customer resets the reprompt budget", async () => {
    const { guard, events } = makeGuard();
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(events).toEqual(["reprompt"]);
    guard.heardCustomer(); // the customer answered...
    guard.armSilence(); // ...and later goes quiet again
    await vi.advanceTimersByTimeAsync(5_001);
    expect(events).toEqual(["reprompt", "reprompt"]); // a fresh reprompt, not the end of the call
  });

  it("0 disables it", async () => {
    const { guard, events } = makeGuard({ silenceTimeoutMs: 0 });
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(events).toEqual([]);
  });

  it("never fires after stop()", async () => {
    const { guard, events } = makeGuard();
    guard.armSilence();
    guard.stop();
    guard.armSilence();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([]);
  });

  it("a throwing callback does not become an unhandled rejection", async () => {
    const { guard } = makeGuard({
      onSilenceEnd: () => {
        throw new Error("boom");
      },
      maxReprompts: 0,
    });
    guard.armSilence();
    await expect(vi.advanceTimersByTimeAsync(5_001)).resolves.not.toThrow();
  });
});
