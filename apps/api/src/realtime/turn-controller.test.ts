/**
 * Deterministic tests of the provider-neutral turn pipeline: real TurnDetector + TurnController, a fake clock and
 * scripted "turns". No sockets, providers, timers or database.
 */
import { describe, it, expect } from "vitest";
import { TurnDetector } from "../audio/turn-detector.js";
import { TurnController, type TurnContext, type TurnControllerOptions } from "./turn-controller.js";

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
