/**
 * When the model fails during a turn the caller is never met with silence: the agent asks them to say it again, in the
 * call's language, and the call carries on (REAL media-stream handler, mock STT/TTS, a model that fails once).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { systemContext } from "../auth/context.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { setLlmProvider, setTtsProvider } from "../adapters/ai/index.js";
import { encodeMockSpeech } from "../adapters/ai/mock.stt.provider.js";
import { MockLlmProvider } from "../adapters/ai/mock.llm.provider.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import type { ILanguageModel } from "../adapters/ai/llm.interface.js";
import { ProviderRequestError } from "../shared/errors.js";
import { fixedLine } from "../modules/ai-agent/fallback-lines.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";
import { relaxRateLimits, startTestApp, waitForSummary } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { callsService } from "../modules/calls/calls.service.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
const phones: PhoneSocket[] = [];
const callIds: string[] = [];

const mediaEvent = (payload: unknown) => JSON.stringify({ event: "media", stream_sid: "s", media: { payload } });
const frames = (buf: Buffer) => Array.from({ length: Math.ceil(buf.length / 1600) }, (_, i) => buf.subarray(i * 1600, (i + 1) * 1600));
function say(phone: PhoneSocket, text: string) {
  for (const f of frames(encodeMockSpeech(text))) phone.ws.send(mediaEvent(f.toString("base64")));
  for (let i = 0; i < 6; i++) phone.ws.send(mediaEvent(Buffer.alloc(1600).toString("base64")));
}

/** A model whose second request (the first caller turn) fails with a provider error. */
function failsOnSecondRequest(): ILanguageModel {
  const mock = new MockLlmProvider();
  let n = 0;
  return {
    name: "fails-once",
    async chat(m, t, o) {
      n++;
      if (n === 2) throw new ProviderRequestError("fails-once", "fails-once llm.chat failed (HTTP 400)", undefined, { category: "invalid_request", operation: "llm.chat", status: 400 });
      return mock.chat(m, t, o);
    },
  };
}

async function run(language: string, callSid: string) {
  const tts = new MockTtsProvider();
  setTtsProvider(tts);
  setLlmProvider(failsOnSecondRequest());
  const agent = await createDefaultAgent(A.orgId, { name: `Recovery ${callSid}`, language, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId: agent.id, callType: "outbound", counterpartyNumber: "+919000066666" });
  callIds.push(call.id);
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  await phone.waitForMarks(1); // the greeting
  say(phone, "what is the price");
  await phone.waitForMarks(2); // the apology
  return { tts, phone };
}

beforeAll(async () => {
  A = await createTenant("MFR_A");
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
  await Promise.all(callIds.splice(0).map((id) => waitForSummary(A.orgId, id, 4_000).catch(() => undefined)));
  setTtsProvider(null);
  setLlmProvider(null);
});

describe("a model failure during a caller's turn", () => {
  it("is answered with a request to repeat, in English for an English agent, and the call stays up", async () => {
    const { tts, phone } = await run("en-IN", "mfr-en");
    expect(tts.requests.map((r) => r.text)).toContain(fixedLine("retry", "en-IN"));
    expect(phone.isOpen()).toBe(true);
  });

  it("is answered in Tamil for a Tamil agent", async () => {
    const { tts, phone } = await run("ta-IN", "mfr-ta");
    const spoken = tts.requests.map((r) => r.text);
    expect(spoken).toContain(fixedLine("retry", "ta-IN"));
    expect(spoken).not.toContain(fixedLine("retry", "en-IN"));
    expect(phone.isOpen()).toBe(true);
  });

  it("the next turn is answered normally", async () => {
    const { tts, phone } = await run("en-IN", "mfr-next");
    say(phone, "are you there");
    await phone.waitForMarks(3);
    // The reply to the second caller turn came from the model, not from a fixed line.
    const spoken = tts.requests.map((r) => r.text);
    expect(spoken.filter((t) => t === fixedLine("retry", "en-IN"))).toHaveLength(1);
    expect(spoken.length).toBeGreaterThanOrEqual(3);
  });
});
