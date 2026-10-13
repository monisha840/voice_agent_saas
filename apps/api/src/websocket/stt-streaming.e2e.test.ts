/**
 * Streaming STT through the REAL media-stream handler: Exotel-style PCM frames in, partial/final transcripts from a
 * (mock) streaming provider, the existing batch LLM + TTS out, real Postgres for the transcript. Verifies what the
 * unit tests cannot: the whole wiring, and that the persisted conversation holds exactly the finals.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";
process.env.REALTIME_STT_STREAMING = "true";

import { systemContext } from "../auth/context.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { setSttProvider } from "../adapters/ai/index.js";
import { ReliableSpeechToText } from "../adapters/ai/reliable-providers.js";
import { MockSttProvider, encodeMockSpeech } from "../adapters/ai/mock.stt.provider.js";
import type { ISpeechToText, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "../adapters/ai/stt.interface.js";
import { ProviderRequestError } from "../shared/errors.js";
import { conversationsRepository } from "../db/repositories/conversations.repository.js";
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
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000066666" });
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  return { call, phone };
}

const mediaEvent = (payload: string) => JSON.stringify({ event: "media", stream_sid: "s", media: { payload } });
function say(phone: PhoneSocket, text: string) {
  const speech = encodeMockSpeech(text);
  for (let i = 0; i < speech.length; i += 1600) phone.ws.send(mediaEvent(speech.subarray(i, i + 1600).toString("base64")));
  for (let i = 0; i < 6; i++) phone.ws.send(mediaEvent(Buffer.alloc(1600).toString("base64")));
}
async function leadTurns(callId: string): Promise<string[]> {
  const convo = await conversationsRepository.findByCallId({ organizationId: A.orgId, callId });
  return ((convo?.transcript ?? []) as Array<{ speaker: string; text: string }>).filter((t) => t.speaker === "lead").map((t) => t.text);
}
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  A = await createTenant("STT_A");
  agentId = (
    await createDefaultAgent(A.orgId, { name: "STT agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
  ).id;
  ({ app, baseUrl } = await startTestApp());
});
afterAll(async () => {
  setSttProvider(null);
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  setSttProvider(null);
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  lifecycle.reset();
  process.env.SILENCE_TIMEOUT_MS = "0";
  process.env.MAX_CALL_DURATION_MS = "0";
});

describe("streaming STT end to end", () => {
  it("transcribes through the stream and stores exactly one lead message per utterance (never a partial)", async () => {
    const { call, phone } = await connect("stt-e2e-1");
    await phone.waitForMarks(1); // greeting
    say(phone, "I'm looking for a 2 BHK in Chennai.");
    await phone.waitForMarks(2);
    say(phone, "My budget is around 70 lakhs.");
    await phone.waitForMarks(3);
    expect(await leadTurns(call.id)).toEqual(["I'm looking for a 2 BHK in Chennai.", "My budget is around 70 lakhs."]);
  });

  it("a provider that repeats its final event produces ONE message and ONE reply", async () => {
    class DupFinal extends MockSttProvider {
      override async startStreaming(h: SttStreamHandlers, o: SttStreamOptions) {
        return super.startStreaming({ ...h, onFinal: (e) => (h.onFinal(e), h.onFinal(e)) }, o);
      }
    }
    setSttProvider(new ReliableSpeechToText(new DupFinal()));
    const { call, phone } = await connect("stt-e2e-dup");
    await phone.waitForMarks(1);
    say(phone, "Tell me about the price.");
    await phone.waitForMarks(2);
    await new Promise((r) => setTimeout(r, 400)); // room for a (wrong) second reply to show up
    expect(phone.marks.length).toBe(2);
    expect(await leadTurns(call.id)).toEqual(["Tell me about the price."]);
  });

  it("a provider disconnect loses that turn, keeps the call up, and the next utterance works on a new session", async () => {
    let sessions = 0;
    class Flaky extends MockSttProvider implements ISpeechToText {
      override async startStreaming(h: SttStreamHandlers, o: SttStreamOptions): Promise<SttStreamingSession> {
        if (++sessions > 1) return super.startStreaming(h, o);
        let open = true;
        return {
          get open() {
            return open;
          },
          sendAudio: () => open,
          startUtterance: () => open,
          endUtterance: () => {
            queueMicrotask(() => {
              open = false;
              h.onError(new ProviderRequestError("mock-stt", "dropped", undefined, { category: "network", operation: "stt.stream" }));
              h.onClose();
            });
            return true;
          },
          close: async () => undefined,
          cancel: () => {
            open = false;
          },
        };
      }
    }
    setSttProvider(new ReliableSpeechToText(new Flaky()));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { call, phone } = await connect("stt-e2e-drop");
    await phone.waitForMarks(1);
    say(phone, "This one is lost.");
    await new Promise((r) => setTimeout(r, 500));
    expect(phone.isOpen()).toBe(true);
    expect(phone.marks.length).toBe(1); // no reply to the lost turn
    say(phone, "This one works.");
    await phone.waitForMarks(2);
    expect(await leadTurns(call.id)).toEqual(["This one works."]);
    expect(sessions).toBe(2);
    vi.restoreAllMocks();
  });

  it("falls back to batch STT when the provider cannot stream, even with streaming enabled", async () => {
    const batchOnly: ISpeechToText = new MockSttProvider();
    // Hide the streaming members: a provider that only offers transcribe().
    setSttProvider({ name: "batch-only", transcribe: (a, o) => batchOnly.transcribe(a, o) });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { call, phone } = await connect("stt-e2e-batch");
    await phone.waitForMarks(1);
    say(phone, "Batch path still works.");
    await phone.waitForMarks(2);
    expect(await leadTurns(call.id)).toEqual(["Batch path still works."]);
    vi.restoreAllMocks();
  });

  it("hanging up mid-utterance cancels the stream and releases the call", async () => {
    let cancelled = 0;
    class Spy extends MockSttProvider {
      override async startStreaming(h: SttStreamHandlers, o: SttStreamOptions) {
        const s = await super.startStreaming(h, o);
        const cancel = s.cancel.bind(s);
        s.cancel = () => (cancelled++, cancel());
        return s;
      }
    }
    setSttProvider(new ReliableSpeechToText(new Spy()));
    const { phone } = await connect("stt-e2e-hangup");
    await phone.waitForMarks(1);
    const speech = encodeMockSpeech("I was saying something long and then");
    for (let i = 0; i < speech.length; i += 1600) phone.ws.send(mediaEvent(speech.subarray(i, i + 1600).toString("base64")));
    await new Promise((r) => setTimeout(r, 100));
    await phone.hangUp();
    await until(() => lifecycle.liveCallCount() === 0);
    await until(() => cancelled >= 1);
  });

  it("concurrent calls keep their transcripts separate", async () => {
    const N = 5;
    const calls = await Promise.all(Array.from({ length: N }, (_, i) => connect(`stt-e2e-conc-${i}`)));
    await Promise.all(calls.map((c) => c.phone.waitForMarks(1)));
    calls.forEach((c, i) => say(c.phone, `Question number ${i} please.`));
    await Promise.all(calls.map((c) => c.phone.waitForMarks(2)));
    for (const [i, c] of calls.entries()) expect(await leadTurns(c.call.id)).toEqual([`Question number ${i} please.`]);
  });
});
