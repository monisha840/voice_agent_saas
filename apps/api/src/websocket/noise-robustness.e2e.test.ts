/**
 * A noisy room through the REAL media-stream handler (mock STT/LLM/TTS): a steady background that is louder than the
 * old fixed speech threshold must not become a stream of caller turns, and a caller who speaks clearly over it is still
 * answered exactly once. Barge-in is off (the default), so the agent is never cut off by the room.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { systemContext } from "../auth/context.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { encodeMockSpeech } from "../adapters/ai/mock.stt.provider.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";
import { relaxRateLimits, startTestApp, waitForSummary } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { callsService } from "../modules/calls/calls.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let agentId = "";
const phones: PhoneSocket[] = [];
const callIds: string[] = [];
const turnLogs: Array<Record<string, unknown>> = [];

const mediaEvent = (payload: unknown) => JSON.stringify({ event: "media", stream_sid: "s", media: { payload } });
const SAMPLES = 800; // 100 ms at 8 kHz
const tone = (amplitude: number) => {
  const b = Buffer.alloc(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
};
const send = (phone: PhoneSocket, frame: Buffer) => phone.ws.send(mediaEvent(frame.toString("base64")));
const frames = (buf: Buffer) => Array.from({ length: Math.ceil(buf.length / 1600) }, (_, i) => buf.subarray(i * 1600, (i + 1) * 1600));

async function connect(callSid: string) {
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000077777" });
  callIds.push(call.id);
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  await phone.waitForMarks(1); // the greeting
  return { call, phone };
}

const userTurns = (callId: string) => turnLogs.filter((t) => t.callId === callId && t.kind === "user");

beforeAll(async () => {
  A = await createTenant("NRB_A");
  agentId = (await createDefaultAgent(A.orgId, { name: "Noise agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })).id;
  ({ app, baseUrl } = await startTestApp());
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try {
      const o = JSON.parse(String(line));
      if (o.message === "turn: finished") turnLogs.push(o);
    } catch {
      // not a JSON log line
    }
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  lifecycle.reset();
  await Promise.all(callIds.splice(0).map((id) => waitForSummary(A.orgId, id, 4_000).catch(() => undefined)));
});

describe("a steady noisy room", () => {
  it("is not answered turn after turn: after it is learned, the room alone starts no more turns", async () => {
    const { call, phone } = await connect("nrb-room");
    // 40 s of a steady background (about 4x the old fixed threshold), as continuous 100 ms frames.
    for (let i = 0; i < 400; i++) send(phone, tone(900));
    for (let i = 0; i < 10; i++) send(phone, Buffer.alloc(SAMPLES * 2));
    await new Promise((r) => setTimeout(r, 600));
    // The first stretch (before the room is known) may become one turn; the rest of the 40 s must not.
    expect(userTurns(call.id).length).toBeLessThanOrEqual(1);
  });
});

describe("a caller speaking over the room", () => {
  it("is answered once", async () => {
    const { call, phone } = await connect("nrb-speech");
    // Let the detector learn the room (quiet-ish background just under the base threshold, then a clear voice).
    for (let i = 0; i < 60; i++) send(phone, tone(300));
    for (const f of frames(encodeMockSpeech("what is the price of a 2 BHK"))) send(phone, f);
    for (let i = 0; i < 6; i++) send(phone, tone(300));
    await phone.waitForMarks(2); // greeting + one reply
    await new Promise((r) => setTimeout(r, 400));
    expect(phone.marks.length).toBe(2);
    expect(userTurns(call.id).filter((t) => t.outcome === "completed")).toHaveLength(1);
  });
});
