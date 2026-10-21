/**
 * The listening window before an agent-ended call hangs up (REAL media-stream handler, mock STT/TTS, a scripted model):
 * the agent does not say goodbye and drop the line the moment it decides to finish. It stays on the line for a while in
 * case the caller was about to add something, and only a silent window ends the call with the goodbye.
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
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import type { ILanguageModel } from "../adapters/ai/llm.interface.js";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A model that finishes the call whenever the caller's words contain "finish", says "Noted." afterwards, and otherwise
 * answers "Sure." Records what it was asked so a test can see the call going on.
 */
function finishingModel(seen: string[]): ILanguageModel {
  return {
    name: "finishing",
    async chat(messages, _tools, opts) {
      const last = messages[messages.length - 1];
      seen.push(`${opts?.toolChoice ?? "-"}|${messages.filter((m) => m.role === "system").map((m) => m.content).join(" ").includes("NOT ending") ? "resumed" : "plain"}`);
      if (opts?.toolChoice === "none") return { content: "Noted." };
      const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (last.role === "user" && /finish/i.test(user)) return { toolCalls: [{ id: `e${seen.length}`, name: "end_call", arguments: {} }] };
      return { content: "Sure." };
    },
  };
}

async function connect(callSid: string) {
  const agent = await createDefaultAgent(A.orgId, { name: `Closing ${callSid}`, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId: agent.id, callType: "outbound", counterpartyNumber: "+919000088888" });
  callIds.push(call.id);
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  await phone.waitForMarks(1); // the greeting
  return phone;
}

beforeAll(async () => {
  A = await createTenant("CLW_A");
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
  process.env.CLOSING_GRACE_MS = "0";
  process.env.CLOSING_GRACE_AFTER_GOODBYE_MS = "0";
});

describe("the closing window", () => {
  it("the line stays open after the agent decides to finish, and a silent window ends with the goodbye", async () => {
    process.env.CLOSING_GRACE_MS = "1500";
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    setLlmProvider(finishingModel([]));
    const phone = await connect("clw-silent");
    const t0 = Date.now();
    say(phone, "please finish the call");
    await phone.waitForMarks(2); // the closing sentence, with no goodbye in it
    expect(tts.requests.at(-1)!.text).toBe("Noted.");
    await sleep(600);
    expect(phone.isOpen()).toBe(true); // still listening, well after the closing sentence
    await phone.closed;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(tts.requests.map((r) => r.text)).toContain(fixedLine("goodbye", "en-IN"));
    expect(phone.marks.length).toBe(3); // greeting, closing sentence, goodbye
  });

  it("a caller who speaks inside the window keeps the call going, and no goodbye is said", async () => {
    process.env.CLOSING_GRACE_MS = "2500";
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    const seen: string[] = [];
    setLlmProvider(finishingModel(seen));
    const phone = await connect("clw-resume");
    say(phone, "please finish the call");
    await phone.waitForMarks(2);
    await sleep(300);
    say(phone, "wait one more thing about the price");
    await phone.waitForMarks(3);
    expect(tts.requests.at(-1)!.text).toBe("Sure.");
    expect(seen.at(-1)).toContain("resumed"); // the model was told the call is not ending
    await sleep(3000); // longer than the original window: nothing may have ended the call
    expect(phone.isOpen()).toBe(true);
    expect(tts.requests.map((r) => r.text)).not.toContain(fixedLine("goodbye", "en-IN"));
  });

  it("a caller who says goodbye themselves is not kept waiting for a minute", async () => {
    process.env.CLOSING_GRACE_MS = "20000";
    process.env.CLOSING_GRACE_AFTER_GOODBYE_MS = "300";
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    setLlmProvider(finishingModel([]));
    const phone = await connect("clw-bye");
    const t0 = Date.now();
    say(phone, "ok thanks bye please finish");
    await phone.closed;
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(tts.requests.map((r) => r.text)).toContain(fixedLine("goodbye", "en-IN"));
  });

  it("with the window disabled (0) the call ends at once, as before", async () => {
    process.env.CLOSING_GRACE_MS = "0";
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    setLlmProvider(finishingModel([]));
    const phone = await connect("clw-zero");
    say(phone, "please finish the call");
    const closed = await phone.closed;
    expect(closed.code).toBeGreaterThan(0);
    expect(phone.marks.length).toBe(2); // greeting and the closing sentence only
  });
});
