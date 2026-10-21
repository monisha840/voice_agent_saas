/**
 * The real-time pipeline through the REAL media-stream WebSocket handler (mock STT/LLM/TTS, real Postgres):
 * live frames, malformed and oversized input, concurrent calls, and cleanup. A bare "phone" (test/phone-socket.ts)
 * plays Exotel.
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
import { relaxRateLimits, startTestApp } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { callsService } from "../modules/calls/calls.service.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let agentId = "";
const phones: PhoneSocket[] = [];

async function connect(callSid: string) {
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000055555" });
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  return { call, phone };
}

const mediaEvent = (payload: unknown) => JSON.stringify({ event: "media", stream_sid: "s", media: { payload } });
const frames = (buf: Buffer) => Array.from({ length: Math.ceil(buf.length / 1600) }, (_, i) => buf.subarray(i * 1600, (i + 1) * 1600));

/** The caller says `text` (scripted speech carried in PCM), then 600 ms of quiet. */
function say(phone: PhoneSocket, text: string) {
  for (const f of frames(encodeMockSpeech(text))) phone.ws.send(mediaEvent(f.toString("base64")));
  for (let i = 0; i < 6; i++) phone.ws.send(mediaEvent(Buffer.alloc(1600).toString("base64")));
}

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  A = await createTenant("RTP_A");
  agentId = (
    await createDefaultAgent(A.orgId, { name: "Realtime agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
  ).id;
  ({ app, baseUrl } = await startTestApp());
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  lifecycle.reset();
  delete process.env.REALTIME_MAX_MALFORMED_FRAMES;
  process.env.SILENCE_TIMEOUT_MS = "0";
  process.env.MAX_CALL_DURATION_MS = "0";
});

describe("live audio through the real handler", () => {
  it("accepts raw PCM frames incrementally and answers the caller's turn", async () => {
    const { phone } = await connect("rtp-basic-1");
    await phone.waitForMarks(1); // greeting
    say(phone, "I'm looking for a 2 BHK.");
    await phone.waitForMarks(2); // the agent replied to the turn
    expect(phone.isOpen()).toBe(true);
  });

  it("malformed frames are dropped without harming the call", async () => {
    const { phone } = await connect("rtp-bad-1");
    await phone.waitForMarks(1);
    for (const bad of [undefined, 42, "", "!!!notbase64!!!", "abc", Buffer.from([1, 2, 3]).toString("base64")]) phone.ws.send(mediaEvent(bad));
    phone.ws.send("this is not json");
    phone.ws.send(JSON.stringify({ event: "media" })); // no media object at all
    say(phone, "Can you tell me the price?");
    await phone.waitForMarks(2);
    expect(phone.isOpen()).toBe(true);
  });

  it("a call that keeps sending garbage audio is dropped and fully cleaned up", async () => {
    process.env.REALTIME_MAX_MALFORMED_FRAMES = "5";
    const { phone } = await connect("rtp-flood-1");
    await phone.waitForMarks(1);
    expect(lifecycle.liveCallCount()).toBe(1);
    for (let i = 0; i < 10; i++) phone.ws.send(mediaEvent("%%%%"));
    await phone.closed;
    await until(() => lifecycle.liveCallCount() === 0);
  });

  it("an oversized WebSocket message closes that socket (1009) and nothing else", async () => {
    const { phone: victim } = await connect("rtp-big-1");
    const { phone: bystander } = await connect("rtp-big-2");
    await victim.waitForMarks(1);
    await bystander.waitForMarks(1);
    victim.ws.send(mediaEvent("A".repeat(600 * 1024)));
    const closed = await victim.closed;
    expect(closed.code).toBe(1009);
    await until(() => lifecycle.liveCallCount() === 1);
    say(bystander, "Still here?");
    await bystander.waitForMarks(2);
  });

  it("an oversized (but small enough for the socket) audio frame is rejected as malformed", async () => {
    const { phone } = await connect("rtp-big-3");
    await phone.waitForMarks(1);
    phone.ws.send(mediaEvent(Buffer.alloc(150_000).toString("base64"))); // 150 KB of PCM > 100 KB frame cap, < 256 KB socket cap
    say(phone, "Hello again.");
    await phone.waitForMarks(2);
    expect(phone.isOpen()).toBe(true);
  });
});

describe("concurrent calls and cleanup", () => {
  it("runs several simultaneous calls independently and leaves nothing live afterwards", async () => {
    const N = 6;
    const calls = await Promise.all(Array.from({ length: N }, (_, i) => connect(`rtp-conc-${i}`)));
    await Promise.all(calls.map((c) => c.phone.waitForMarks(1)));
    expect(lifecycle.liveCallCount()).toBe(N);

    calls.forEach((c, i) => say(c.phone, `Question number ${i} about the project.`));
    await Promise.all(calls.map((c) => c.phone.waitForMarks(2)));
    // Each call got exactly one reply to its one question.
    expect(calls.every((c) => c.phone.marks.length === 2)).toBe(true);

    await Promise.all(calls.map((c) => c.phone.hangUp()));
    await until(() => lifecycle.liveCallCount() === 0);
  });

  it("hanging up mid-turn cancels the work and releases the call", async () => {
    const { phone } = await connect("rtp-hangup-1");
    await phone.waitForMarks(1);
    say(phone, "Tell me everything about the project.");
    await phone.hangUp(); // immediately: the turn is (or is about to be) in flight
    await until(() => lifecycle.liveCallCount() === 0);
  });
});
