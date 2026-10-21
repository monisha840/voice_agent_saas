/**
 * Output generations: audio of a turn that was cleared (barge-in / cancellation) can never be queued afterwards, and a
 * stale clear can never wipe a newer turn's audio.
 */
import { describe, it, expect } from "vitest";
import { OutboundAudioSender, type OutboundItem } from "./outbound-audio.js";

const item = (p: string, weight = 10): OutboundItem => ({ payload: p, weight, audio: true });
function sender(buffered = 1_000_000) {
  const wire: string[] = [];
  const s = new OutboundAudioSender({ send: (p) => void wire.push(p), bufferedAmount: () => buffered, maxQueuedBytes: 1000, highWaterBytes: 100, retryMs: 5 });
  return { s, wire };
}

describe("OutboundAudioSender generations", () => {
  it("clear() starts a new generation; the old generation's audio is refused, the new one's is accepted", () => {
    const { s } = sender(); // congested: nothing leaves the queue
    const turnA = s.generation;
    expect(s.enqueue([item("a1")], turnA)).toBe(true);
    expect(s.clear()).toBe(10); // barge-in
    const turnB = s.generation;
    expect(turnB).not.toBe(turnA);
    expect(s.isCurrent(turnA)).toBe(false);
    expect(s.enqueue([item("a2")], turnA)).toBe(false); // a late provider callback of turn A
    expect(s.length).toBe(0);
    expect(s.enqueue([item("b1")], turnB)).toBe(true);
    expect(s.length).toBe(1);
  });

  it("a stale clear(generation) is a no-op: it cannot wipe the newer turn's queued audio", () => {
    const { s } = sender();
    const turnA = s.generation;
    s.clear();
    const turnB = s.generation;
    s.enqueue([item("b1"), item("b2")], turnB);
    expect(s.clear(turnA)).toBe(0); // turn A's cleanup arriving late
    expect(s.length).toBe(2);
    expect(s.clear(turnB)).toBe(20);
    expect(s.length).toBe(0);
  });

  it("calls without a generation behave as before", () => {
    const { s, wire } = sender(0);
    expect(s.enqueue([item("x")])).toBe(true);
    expect(wire).toEqual(["x"]);
    s.clear();
    expect(s.enqueue([item("y")])).toBe(true);
  });

  it("close() refuses everything and leaves no timer", () => {
    const { s } = sender();
    s.enqueue([item("a")], s.generation); // schedules a retry timer
    s.close();
    expect(s.enqueue([item("b")], s.generation)).toBe(false);
    expect(s.length).toBe(0);
  });
});
