/**
 * Deterministic tests of the provider-neutral turn pipeline: real TurnDetector + TurnController, a fake clock and
 * scripted "turns". No sockets, providers, timers or database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TurnDetector } from "../audio/turn-detector.js";
import { metrics } from "../runtime/metrics.js";
import { MIN_TURN_DEADLINE_MS, TurnController, TurnDeadlineError, type TurnContext, type TurnControllerOptions } from "./turn-controller.js";

const FRAME = 800; // 100 ms at 8 kHz
const loud = () => {
  const b = Buffer.alloc(FRAME * 2);
  for (let i = 0; i < FRAME; i++) b.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
  return b;
};
const quiet = () => Buffer.alloc(FRAME * 2);

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

interface Rig {
  c: TurnController;
  turns: Array<{ ctx: TurnContext; pcm: Buffer; gate: ReturnType<typeof deferred> }>;
  finished: Array<Record<string, unknown>>;
  warnings: string[];
  interrupted: string[];
  idleCount: () => number;
  activity: () => number;
  abort: AbortController;
  clock: { t: number };
  /** Speak: n loud frames, then n quiet frames to end the utterance (endSilence = 3 frames). */
  say(frames?: number): void;
  speak(n: number): void;
  hush(n: number): void;
}

function rig(over: Partial<TurnControllerOptions> = {}, onTurn?: (ctx: TurnContext, gate: ReturnType<typeof deferred>) => Promise<void>): Rig {
  const clock = { t: 1_000 };
  const abort = new AbortController();
  const turns: Rig["turns"] = [];
  const finished: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const interrupted: string[] = [];
  let idle = 0;
  let activity = 0;
  const c = new TurnController({
    ids: { callId: "call-12345678", agentId: "agent-1", organizationId: "org-1" },
    vad: new TurnDetector({ sampleRate: 8000, energyThreshold: 500, minSpeechMs: 200, endSilenceMs: 300, maxUtteranceMs: 15000, preRollMs: 200 }),
    callSignal: abort.signal,
    now: () => clock.t,
    log: {
      info: (m, f) => {
        if (m === "turn: finished") finished.push(f ?? {});
      },
      warn: (m) => void warnings.push(m),
    },
    runUserTurn: async (pcm, ctx) => {
      const gate = deferred();
      turns.push({ ctx, pcm, gate });
      if (onTurn) return onTurn(ctx, gate);
      await gate.promise;
    },
    onInterrupt: (t) => void interrupted.push(t.turnId),
    onIdle: () => void idle++,
    onUserActivity: () => void activity++,
    ...over,
  });
  const speak = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 100;
      c.pushAudio(loud());
    }
  };
  const hush = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 100;
      c.pushAudio(quiet());
    }
  };
  return {
    c,
    turns,
    finished,
    warnings,
    interrupted,
    idleCount: () => idle,
    activity: () => activity,
    abort,
    clock,
    say: (frames = 4) => {
      speak(frames);
      hush(3);
    },
    speak,
    hush,
  };
}

describe("TurnController: speech to turn", () => {
  it("moves IDLE -> USER_SPEAKING -> USER_SILENCE -> PROCESSING and starts exactly one turn", async () => {
    const r = rig();
    expect(r.c.state).toBe("IDLE");
    r.speak(4);
    expect(r.c.state).toBe("USER_SPEAKING");
    r.hush(1);
    expect(r.c.state).toBe("USER_SILENCE");
    r.hush(1);
    expect(r.turns.length).toBe(0); // still waiting: 200 ms of 300 ms
    r.speak(1); // speech resumes
    expect(r.c.state).toBe("USER_SPEAKING");
    r.hush(3);
    expect(r.c.state).toBe("PROCESSING");
    expect(r.turns.length).toBe(1);
    expect(r.c.history.map((h) => h.to)).toEqual(["USER_SPEAKING", "USER_SILENCE", "USER_SPEAKING", "USER_SILENCE", "PROCESSING"]);

    r.turns[0].gate.resolve();
    await tick();
    expect(r.c.state).toBe("IDLE");
    expect(r.idleCount()).toBe(1);
    expect(r.finished[0]).toMatchObject({ outcome: "completed", kind: "user", callId: "call-12345678", agentId: "agent-1", organizationId: "org-1" });
  });

  it("never sends silence or a noise blip downstream, and returns to IDLE", () => {
    const r = rig();
    r.hush(30);
    expect(r.c.state).toBe("IDLE");
    r.speak(1); // 100 ms < minSpeechMs 200
    r.hush(4);
    expect(r.turns.length).toBe(0);
    expect(r.c.state).toBe("IDLE");
    expect(r.c.stats.turnsStarted).toBe(0);
  });

  it("hands the turn the utterance PCM (internal format) and stamps speech start/end on its metrics", async () => {
    const r = rig();
    r.hush(2);
    r.clock.t = 5_000;
    r.speak(4); // speech starts at ~5100
    r.hush(3); // ends: now = 5700, silence 300 => speechEnd = 5400
    const { ctx, pcm } = r.turns[0];
    expect(pcm.length % 2).toBe(0);
    expect(pcm.length).toBe((2 + 4 + 3) * FRAME * 2); // 200 ms pre-roll + speech + trailing silence
    expect(ctx.metrics.stamps.speechStart).toBe(5_100);
    expect(ctx.metrics.stamps.speechEnd).toBe(5_400);
    ctx.metrics.mark("sttStart", 5_450);
    ctx.metrics.mark("sttEnd", 5_650);
    ctx.metrics.mark("firstAudioByte", 6_400);
    r.turns[0].gate.resolve();
    await tick();
    expect(r.finished[0]).toMatchObject({ userSpeechMs: 300, sttMs: 200, speechEndToSttEndMs: 250, speechEndToFirstAudioMs: 1_000 });
  });

  it("assigns unique, ordered turn ids", async () => {
    const r = rig();
    r.say();
    r.turns[0].gate.resolve();
    await tick();
    r.say();
    r.turns[1].gate.resolve();
    await tick();
    expect(r.turns.map((t) => t.ctx.turnId)).toEqual(["call-123-t1", "call-123-t2"]);
  });

  it("reports caller activity so silence timers can be reset, but only for speech frames", () => {
    const r = rig();
    r.hush(5);
    expect(r.activity()).toBe(0);
    r.speak(3);
    expect(r.activity()).toBe(3);
  });
});

describe("TurnController: cancellation", () => {
  it("call end aborts the turn's signal and records it as cancelled, not as an error", async () => {
    const r = rig({}, (ctx, gate) => new Promise<void>((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })).finally(() => gate.resolve()));
    r.say();
    const { ctx } = r.turns[0];
    expect(ctx.signal.aborted).toBe(false);
    r.abort.abort();
    await tick();
    expect(ctx.signal.aborted).toBe(true);
    expect(r.finished[0]).toMatchObject({ outcome: "cancelled", cancelled: true });
    expect(r.warnings).toEqual([]); // not logged as a failure
  });

  it("cancelCurrent aborts only the turn in flight", async () => {
    const r = rig();
    r.say();
    expect(r.c.cancelCurrent("test")).toBe(true);
    expect(r.turns[0].ctx.signal.aborted).toBe(true);
    expect(r.abort.signal.aborted).toBe(false);
    r.turns[0].gate.resolve();
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "cancelled" });
    expect(r.c.cancelCurrent()).toBe(false); // nothing in flight any more
  });

  it("a genuine failure is logged with its error name and does not wedge the pipeline", async () => {
    const r = rig();
    r.say();
    r.turns[0].gate.reject(new TypeError("boom"));
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "error", errorName: "TypeError" });
    expect(r.warnings).toContain("turn: failed");
    expect(r.c.state).toBe("IDLE");
    r.say();
    expect(r.turns.length).toBe(2); // next turn runs normally
  });

  it("close() cancels the turn, drops queued utterances, releases the VAD buffer and refuses more audio", async () => {
    const r = rig();
    r.say();
    r.say(); // queued behind the first
    expect(r.c.pendingCount).toBe(1);
    r.speak(2); // VAD now holds a partial utterance
    r.c.close();
    expect(r.turns[0].ctx.signal.aborted).toBe(true);
    expect(r.c.pendingCount).toBe(0);
    expect(r.c.state).toBe("CLOSED");
    const framesBefore = r.c.stats.framesIn;
    r.speak(5);
    expect(r.c.stats.framesIn).toBe(framesBefore);
    r.turns[0].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(1); // nothing new started after close
    expect(r.c.state).toBe("CLOSED");
    r.c.close(); // idempotent
  });
});

describe("TurnController: backpressure", () => {
  it("never runs two turns at once and bounds the queue, dropping (and counting) the oldest", async () => {
    let running = 0;
    let maxRunning = 0;
    const r = rig({ maxPendingUtterances: 2 }, async (_ctx, gate) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running--;
    });
    for (let i = 0; i < 5; i++) r.say(); // 5 utterances while the first is still being processed
    expect(r.turns.length).toBe(1);
    expect(r.c.pendingCount).toBe(2);
    expect(r.c.stats.droppedUtterances).toBe(2);

    r.turns[0].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(2);
    r.turns[1].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(3);
    r.turns[2].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(3);
    expect(maxRunning).toBe(1);
    expect(r.c.state).toBe("IDLE");
  });

  it("caps the VAD buffer: an utterance that never ends is cut at maxUtteranceMs", () => {
    const r = rig();
    r.speak(200); // 20 s of continuous speech; cap is 15 s
    expect(r.turns.length).toBeGreaterThanOrEqual(1);
    expect(r.turns[0].pcm.length).toBeLessThanOrEqual(15_100 * 16);
  });

  it("an agent-initiated turn is refused while anything is in flight, so it cannot talk over a turn", async () => {
    const r = rig();
    r.say();
    expect(await r.c.runAiTurn(async () => undefined)).toBe(false);
    expect(r.c.isIdle).toBe(false);
    r.turns[0].gate.resolve();
    await tick();
    let ran = false;
    expect(await r.c.runAiTurn(async () => void (ran = true))).toBe(true);
    expect(ran).toBe(true);
    expect(r.c.state).toBe("IDLE");
  });
});

describe("TurnController: half-duplex (barge-in off, the default)", () => {
  it("ignores caller audio while the AI is speaking, then listens again the moment playback ends", async () => {
    const r = rig({}, async (ctx, gate) => {
      ctx.beginAiSpeaking();
      await gate.promise;
    });
    r.say();
    expect(r.c.state).toBe("AI_SPEAKING");
    const before = r.c.stats.framesIn;
    r.speak(6);
    r.hush(4);
    expect(r.c.stats.framesIn).toBe(before); // not analysed at all
    expect(r.turns.length).toBe(1);

    r.turns[0].ctx.endAiSpeaking();
    expect(r.c.state).toBe("IDLE");
    r.say(); // same tick: a frame right after the mark is the customer's speech
    expect(r.c.pendingCount).toBe(1); // queued behind the (not yet settled) first turn
    r.turns[0].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(2);
  });

  it("the agent's own greeting is not interrupted by line noise", async () => {
    const r = rig();
    const done = r.c.runAiTurn(async (turn) => {
      turn.beginAiSpeaking();
      await new Promise((res) => setTimeout(res, 20));
    });
    r.speak(5);
    r.hush(4);
    expect(r.turns.length).toBe(0);
    await done;
  });
});

describe("TurnController: barge-in", () => {
  const withBargeIn = (min = 300) => ({ bargeIn: { enabled: true, minSpeechMs: min } });
  /** A turn that starts speaking and stays "playing" until aborted or gated. */
  const speakingTurn = async (ctx: TurnContext, gate: ReturnType<typeof deferred>) => {
    ctx.beginAiSpeaking();
    await Promise.race([gate.promise, new Promise<void>((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }))]);
  };

  it("caller speech during AI_SPEAKING cancels the reply, clears outbound audio, and keeps listening", async () => {
    const r = rig(withBargeIn(), speakingTurn);
    r.say();
    expect(r.c.state).toBe("AI_SPEAKING");
    const first = r.turns[0].ctx;

    r.speak(2); // 200 ms: below the 300 ms threshold -> not an interruption
    expect(first.signal.aborted).toBe(false);
    r.speak(1); // 300 ms: interruption
    expect(first.signal.aborted).toBe(true);
    expect(r.interrupted).toEqual([first.turnId]);
    expect(r.c.state).toBe("USER_SPEAKING");
    expect(r.c.history.map((h) => h.to)).toEqual(expect.arrayContaining(["AI_SPEAKING", "INTERRUPTED", "USER_SPEAKING"]));
    expect(r.c.stats.interruptions).toBe(1);
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "interrupted", interrupted: true });
  });

  it("the interrupting speech becomes the next turn, and only after the old turn has fully settled", async () => {
    const r = rig(withBargeIn(), async (ctx, gate) => {
      if (r.turns.length === 1) await speakingTurn(ctx, gate);
      else await gate.promise;
    });
    r.say(); // turn 1 is speaking
    r.speak(4); // caller talks over it
    r.hush(3); // ...and finishes their sentence
    // The old turn has not unwound yet (microtasks pending): nothing new may start.
    expect(r.turns.length).toBe(1);
    expect(r.c.pendingCount).toBe(1);
    await tick();
    expect(r.turns.length).toBe(2); // the caller's new sentence is NOT lost
    expect(r.c.state).toBe("PROCESSING");
    expect(r.finished[0]).toMatchObject({ outcome: "interrupted" });
    r.turns[1].gate.resolve();
    await tick();
    expect(r.finished[1]).toMatchObject({ outcome: "completed" });
  });

  it("interrupting while the agent is still thinking (PROCESSING) cancels the generation too", async () => {
    const r = rig(withBargeIn(200));
    r.say(); // turn 1: PROCESSING (never starts speaking)
    expect(r.c.state).toBe("PROCESSING");
    r.speak(2);
    expect(r.turns[0].ctx.signal.aborted).toBe(true);
    expect(r.c.state).toBe("USER_SPEAKING");
    r.turns[0].gate.resolve();
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "interrupted" });
  });

  it("discards queued utterances that predate the interruption", async () => {
    const r = rig({ ...withBargeIn(500), maxPendingUtterances: 5 });
    r.say(3); // turn 1 in flight
    r.say(3); // 300 ms < 500 ms: not an interruption, so it just queues
    expect(r.c.pendingCount).toBe(1);
    expect(r.c.stats.interruptions).toBe(0);
    r.speak(5); // 500 ms of speech over the reply: interruption
    expect(r.c.stats.interruptions).toBe(1);
    expect(r.c.pendingCount).toBe(0); // the stale queued utterance is gone
    r.hush(3);
    r.turns[0].gate.resolve();
    await tick();
    expect(r.turns.length).toBe(2);
    expect(r.turns[1].pcm.length).toBe(8 * FRAME * 2); // the interrupting sentence (5 speech + 3 silence), not the stale one
  });

  describe("with an energy ratio (the caller must be clearly louder than the room)", () => {
    const toneFrame = (amplitude: number) => {
      const b = Buffer.alloc(FRAME * 2);
      for (let i = 0; i < FRAME; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
      return b;
    };
    const roomRig = () => {
      const vad = new TurnDetector({ sampleRate: 8000, energyThreshold: 500, minSpeechMs: 200, endSilenceMs: 300, maxUtteranceMs: 15000, preRollMs: 200, floorMultiplier: 1 });
      const r = rig({ bargeIn: { enabled: true, minSpeechMs: 300, energyRatio: 6 }, vad }, speakingTurn);
      for (let i = 0; i < 15; i++) {
        r.clock.t += 100;
        r.c.pushAudio(toneFrame(450)); // a steady room just under the speech threshold: floor ~450
      }
      return r;
    };
    const push = (r: ReturnType<typeof rig>, amplitude: number, frames: number) => {
      for (let i = 0; i < frames; i++) {
        r.clock.t += 100;
        r.c.pushAudio(toneFrame(amplitude));
      }
    };

    it("speech that is long but only as loud as the room (echo, people talking nearby) does not interrupt", () => {
      const r = roomRig();
      r.say(); // a turn that is now speaking
      expect(r.c.state).toBe("AI_SPEAKING");
      push(r, 2000, 12); // 1.2 s, well over minSpeechMs, but only ~4x the room
      expect(r.c.stats.interruptions).toBe(0);
      expect(r.turns[0].ctx.signal.aborted).toBe(false);
    });

    it("a clearly stronger voice does interrupt", () => {
      const r = roomRig();
      r.say();
      push(r, 8000, 5); // ~18x the room
      expect(r.c.stats.interruptions).toBe(1);
    });
  });

  it("with barge-in off the same speech is only queued, never cancelling the reply", async () => {
    const r = rig({}, async (ctx, gate) => {
      await gate.promise;
      void ctx;
    });
    r.say();
    r.say();
    expect(r.turns[0].ctx.signal.aborted).toBe(false);
    expect(r.c.stats.interruptions).toBe(0);
    expect(r.c.pendingCount).toBe(1);
  });
});

describe("TurnController: isolation between calls", () => {
  it("many simultaneous controllers do not share state, turns or queues", async () => {
    const rigs = Array.from({ length: 25 }, () => rig());
    rigs.forEach((r, i) => r.say(2 + (i % 5)));
    expect(rigs.every((r) => r.turns.length === 1 && r.c.state === "PROCESSING")).toBe(true);
    // Cancel the even calls only.
    rigs.forEach((r, i) => i % 2 === 0 && r.abort.abort());
    await tick();
    rigs.forEach((r, i) => {
      expect(r.turns[0].ctx.signal.aborted).toBe(i % 2 === 0);
      r.turns[0].gate.resolve();
    });
    await tick();
    rigs.forEach((r, i) => expect(r.finished[0]).toMatchObject({ outcome: i % 2 === 0 ? "cancelled" : "completed" }));
    rigs.forEach((r) => r.c.close());
    expect(rigs.every((r) => r.c.state === "CLOSED" && r.c.pendingCount === 0)).toBe(true);
  });
});

describe("TurnController: turn identity (a cancelled turn never touches a newer one)", () => {
  const speakingTurn = async (ctx: TurnContext, gate: ReturnType<typeof deferred>) => {
    ctx.beginAiSpeaking();
    await Promise.race([gate.promise, new Promise<void>((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }))]);
  };
  const withBargeIn = { bargeIn: { enabled: true, minSpeechMs: 300 } };

  it("every turn has its own id and signal; only the current, un-cancelled turn is active", async () => {
    const r = rig(withBargeIn, async (ctx, gate) => {
      if (r.turns.length === 1) await speakingTurn(ctx, gate);
      else await gate.promise;
    });
    r.say();
    const a = r.turns[0].ctx;
    expect(a.isActive()).toBe(true);
    r.speak(4);
    r.hush(3);
    await tick();
    const b = r.turns[1].ctx;
    expect(b.turnId).not.toBe(a.turnId);
    expect(b.signal).not.toBe(a.signal);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(a.isActive()).toBe(false);
    expect(b.isActive()).toBe(true);
  });

  it("late calls from the interrupted turn are refused and cannot move the newer turn's state", async () => {
    const r = rig(withBargeIn, async (ctx, gate) => {
      if (r.turns.length === 1) await speakingTurn(ctx, gate);
      else {
        ctx.beginAiSpeaking(); // the NEW turn is now speaking
        await gate.promise;
      }
    });
    r.say();
    const a = r.turns[0].ctx;
    r.speak(4);
    r.hush(3);
    await tick();
    const b = r.turns[1].ctx;
    expect(r.c.state).toBe("AI_SPEAKING"); // turn B speaks
    expect(a.beginAiSpeaking()).toBe(false); // A's straggling "first audio" is refused
    a.endAiSpeaking(); // A's straggling "playback finished" must not end B's speech
    expect(r.c.state).toBe("AI_SPEAKING");
    a.metrics.mark("ttsFirstAudio"); // and A's metrics are A's own
    expect(b.metrics.stamps.ttsFirstAudio).toBeUndefined();
    r.turns[1].gate.resolve();
    await tick();
    expect(r.finished[0]).toMatchObject({ outcome: "interrupted", turnId: a.turnId });
    expect(r.finished[1]).toMatchObject({ outcome: "completed", turnId: b.turnId });
  });
});

/**
 * The turn deadline. One clock drives everything here: vitest's fake timers fake `Date` AND `setTimeout`, and the
 * controller's `now` is `Date.now`, so the deadline, the metrics' stamps and the timer cannot drift apart.
 * `setImmediate` is deliberately left real so `tick()` still flushes microtasks.
 */
describe("TurnController: turn deadline", () => {
  const T0 = 1_700_000_000_000;
  const TRAILING_SILENCE_MS = 300; // say() ends with 3 quiet frames; speechEnd is back-dated by them
  const DEADLINE_WARNING = "turn: deadline exceeded, caller turn abandoned";
  const METRIC = "realtime_turn_deadline_abandoned_total";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A turn whose provider never answers on its own: it ends only when the turn's signal is aborted. */
  const hang = (ctx: TurnContext, gate: ReturnType<typeof deferred>) =>
    new Promise<void>((resolve, reject) => {
      gate.promise.then(resolve, reject);
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    });

  function deadlineRig(over: Partial<TurnControllerOptions> = {}, onTurn?: (ctx: TurnContext, gate: ReturnType<typeof deferred>) => Promise<void>) {
    const logs: Array<{ level: "info" | "warn"; message: string; fields: Record<string, unknown> }> = [];
    const r = rig(
      {
        now: () => Date.now(),
        turnDeadlineMs: 2000,
        log: {
          info: (message, fields) => void logs.push({ level: "info", message, fields: fields ?? {} }),
          warn: (message, fields) => void logs.push({ level: "warn", message, fields: fields ?? {} }),
        },
        ...over,
      },
      onTurn,
    );
    return { ...r, logs, find: (message: string) => logs.filter((l) => l.message === message) };
  }

  it("leaves a turn that gets audio out in time alone", async () => {
    const r = deadlineRig({}, async (ctx, gate) => {
      ctx.beginAiSpeaking();
      ctx.metrics.mark("firstAudioByte");
      await gate.promise;
    });
    r.say();
    expect(r.c.state).toBe("AI_SPEAKING");
    vi.advanceTimersByTime(60_000); // far beyond the deadline
    expect(r.c.stats.deadlineAbandoned).toBe(0);
    expect(r.turns[0].ctx.signal.aborted).toBe(false);
    r.turns[0].gate.resolve();
    await tick();
    expect(r.find(DEADLINE_WARNING)).toHaveLength(0);
    expect(r.find("turn: finished")[0].fields).toMatchObject({ outcome: "completed" });
    expect(r.find("turn: finished")[0].fields.deadlineExceeded).toBeUndefined();
  });

  it("abandons a caller turn that produced no outbound audio, exactly once", async () => {
    const before = metrics.get(METRIC, { stage: "stt" });
    const r = deadlineRig({}, hang);
    r.say();
    const ctx = r.turns[0].ctx;
    vi.advanceTimersByTime(2_000 - TRAILING_SILENCE_MS - 1);
    expect(r.c.stats.deadlineAbandoned).toBe(0);
    expect(ctx.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBeInstanceOf(TurnDeadlineError);
    expect(ctx.metrics.deadlineExceeded).toBe(true);
    await tick();

    vi.advanceTimersByTime(60_000); // a second firing must be impossible
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(r.find(DEADLINE_WARNING)).toHaveLength(1);
    expect(metrics.get(METRIC, { stage: "stt" }) - before).toBe(1);
    // An abandoned turn is a cancelled turn (the existing concept), not a failed one.
    expect(r.find("turn: finished")).toHaveLength(1);
    expect(r.find("turn: finished")[0].fields).toMatchObject({ outcome: "cancelled", cancelled: true, deadlineExceeded: true, turnId: ctx.turnId });
    expect(r.find("turn: failed")).toHaveLength(0);
    expect(r.c.state).toBe("IDLE"); // the call is not ended
  });

  it("measures the deadline from the end of the caller's speech, like speechEndToFirstAudioMs does", async () => {
    const r = deadlineRig({}, hang);
    r.say();
    const speechEnd = r.turns[0].ctx.metrics.stamps.speechEnd;
    expect(speechEnd).toBe(T0 - TRAILING_SILENCE_MS);
    vi.advanceTimersByTime(2_000 - TRAILING_SILENCE_MS);
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(Date.now() - (speechEnd ?? 0)).toBe(2_000); // the deadline, not 2000 ms after the turn object was made
    await tick();
  });

  it("logs the abandonment once, with the elapsed ms and the call id, and carries no content", async () => {
    const r = deadlineRig({}, hang);
    r.say();
    vi.advanceTimersByTime(2_000);
    await tick();
    const warnings = r.find(DEADLINE_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warn"); // expected, but notable
    expect(warnings[0].fields).toMatchObject({
      callId: "call-12345678",
      turnId: "call-123-t1",
      stage: "stt",
      elapsedMs: 2_000,
      deadlineMs: 2_000,
    });
    // Ids, timings and the stage ONLY: no transcript, prompt, audio or utterance buffer.
    expect(Object.keys(warnings[0].fields).sort()).toEqual(["agentId", "callId", "deadlineMs", "elapsedMs", "organizationId", "stage", "turnId"]);
  });

  it("labels the stage the abandoned turn was waiting on", async () => {
    const before = metrics.get(METRIC, { stage: "llm" });
    const r = deadlineRig({}, async (ctx, gate) => {
      ctx.metrics.mark("sttEnd");
      ctx.metrics.mark("llmStart"); // STT answered; the model is the one hanging
      return hang(ctx, gate);
    });
    r.say();
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(r.find(DEADLINE_WARNING)[0].fields).toMatchObject({ stage: "llm" });
    expect(metrics.get(METRIC, { stage: "llm" }) - before).toBe(1);
  });

  it("a late result cannot be spoken after the turn was abandoned", async () => {
    // This turn ignores its signal: the provider answers eventually, deadline or no deadline.
    const r = deadlineRig({}, async (_ctx, gate) => void (await gate.promise));
    r.say();
    const ctx = r.turns[0].ctx;
    vi.advanceTimersByTime(2_000);
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    // Both gates the real speaking paths check (handler: `turn.signal.aborted` / `beginAiSpeaking`, tts-stream.ts: `beginAiSpeaking`).
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.isActive()).toBe(false);
    expect(ctx.beginAiSpeaking()).toBe(false);
    expect(r.c.state).not.toBe("AI_SPEAKING");

    r.turns[0].gate.resolve(); // the late answer finally arrives
    await tick();
    expect(ctx.beginAiSpeaking()).toBe(false);
    expect(ctx.isActive()).toBe(false);
    expect(r.c.state).toBe("IDLE");
    expect(r.c.history.map((h) => h.to)).not.toContain("AI_SPEAKING");
  });

  it("keeps the session usable: the next turn runs normally after an abandoned one", async () => {
    const r = deadlineRig({}, async (ctx, gate) => {
      if (r.turns.length === 1) return hang(ctx, gate);
      await gate.promise;
    });
    r.say();
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(r.c.state).toBe("IDLE");
    expect(r.c.turnInFlight).toBe(false);

    r.say(); // the caller tries again
    expect(r.turns).toHaveLength(2);
    const second = r.turns[1].ctx;
    expect(second.signal.aborted).toBe(false);
    expect(second.isActive()).toBe(true);
    expect(second.beginAiSpeaking()).toBe(true);
    second.metrics.mark("firstAudioByte");
    vi.advanceTimersByTime(60_000);
    expect(r.c.stats.deadlineAbandoned).toBe(1); // the healthy turn is untouched
    r.turns[1].gate.resolve();
    await tick();
    expect(r.find("turn: finished")[1].fields).toMatchObject({ outcome: "completed", turnId: second.turnId });
  });

  it("an utterance the caller queued while the turn hung becomes the next turn", async () => {
    const r = deadlineRig({ maxPendingUtterances: 2 }, async (ctx, gate) => {
      if (r.turns.length === 1) return hang(ctx, gate);
      await gate.promise;
    });
    r.say();
    r.say(); // "hello? are you there?" queued behind the hung turn
    expect(r.c.pendingCount).toBe(1);
    vi.advanceTimersByTime(2_000);
    await tick();
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(r.c.stats.droppedUtterances).toBe(0); // NOT discarded: an abandonment is not a barge-in
    expect(r.turns).toHaveLength(2);
    r.turns[1].gate.resolve();
    await tick();
  });

  it("does not apply to an agent-initiated turn (a greeting answers no one's question)", async () => {
    const r = deadlineRig();
    const gate = deferred();
    const done = r.c.runAiTurn(() => gate.promise);
    vi.advanceTimersByTime(60_000);
    expect(r.c.stats.deadlineAbandoned).toBe(0);
    expect(r.find(DEADLINE_WARNING)).toHaveLength(0);
    gate.resolve();
    await done;
  });

  it("close() disarms the deadline: a closed call cannot be abandoned afterwards", async () => {
    const r = deadlineRig({}, hang);
    r.say();
    r.c.close();
    await tick();
    vi.advanceTimersByTime(60_000);
    expect(r.c.stats.deadlineAbandoned).toBe(0);
    expect(r.find(DEADLINE_WARNING)).toHaveLength(0);
    expect(r.c.state).toBe("CLOSED");
  });

  it("clamps a configured deadline below the floor up to it", () => {
    const previous = process.env.REALTIME_TURN_DEADLINE_MS;
    try {
      process.env.REALTIME_TURN_DEADLINE_MS = "500";
      expect(deadlineRig({ turnDeadlineMs: undefined }).c.turnDeadlineMs).toBe(MIN_TURN_DEADLINE_MS);
      process.env.REALTIME_TURN_DEADLINE_MS = "9000";
      expect(deadlineRig({ turnDeadlineMs: undefined }).c.turnDeadlineMs).toBe(9_000);
    } finally {
      if (previous === undefined) delete process.env.REALTIME_TURN_DEADLINE_MS;
      else process.env.REALTIME_TURN_DEADLINE_MS = previous;
    }
    expect(MIN_TURN_DEADLINE_MS).toBe(2_000);
    expect(deadlineRig({ turnDeadlineMs: 500 }).c.turnDeadlineMs).toBe(MIN_TURN_DEADLINE_MS);
    expect(deadlineRig({ turnDeadlineMs: 30_000 }).c.turnDeadlineMs).toBe(30_000);
  });

  it("a clamped deadline fires at the floor, not at the value that was configured", async () => {
    const r = deadlineRig({ turnDeadlineMs: 500 }, hang);
    r.say();
    vi.advanceTimersByTime(500); // what was asked for
    expect(r.c.stats.deadlineAbandoned).toBe(0);
    vi.advanceTimersByTime(2_000 - TRAILING_SILENCE_MS - 500); // the floor
    expect(r.c.stats.deadlineAbandoned).toBe(1);
    expect(r.find(DEADLINE_WARNING)[0].fields).toMatchObject({ deadlineMs: MIN_TURN_DEADLINE_MS, elapsedMs: 2_000 });
    await tick();
  });
});
