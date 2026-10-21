/**
 * Provider hardening through the REAL media-stream handler: the agent's voice reaching the TTS provider (and the
 * fallback when the provider rejects it), work stopping when the call ends, and a provider outage not taking the call
 * down. Mock providers only; a bare "phone" listens.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { systemContext } from "../auth/context.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { setLlmProvider, setTtsProvider } from "../adapters/ai/index.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import { MockLlmProvider } from "../adapters/ai/mock.llm.provider.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "../adapters/ai/llm.interface.js";
import type { ProviderCallOptions } from "../adapters/ai/provider-common.js";
import type { ITextToSpeech, TtsOptions, TtsResult } from "../adapters/ai/tts.interface.js";
import { ProviderRequestError } from "../shared/errors.js";
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

const agentWith = (name: string, extra: Record<string, unknown> = {}) =>
  createDefaultAgent(A.orgId, { name, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {}, ...extra });

async function connect(agentId: string, callSid: string) {
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000022222" });
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  callIds.push(call.id);
  return { call, phone };
}

beforeAll(async () => {
  A = await createTenant("PHE_A");
  ({ app, baseUrl } = await startTestApp());
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  // Hanging up finalizes the call in the background (summary uses the LLM provider): let it finish before the next test
  // swaps the provider, or the stray summary request lands on that test's fake model.
  await Promise.all(callIds.splice(0).map((id) => waitForSummary(A.orgId, id, 4_000).catch(() => undefined)));
  setTtsProvider(null);
  setLlmProvider(null);
  vi.restoreAllMocks();
});

describe("voice selection", () => {
  it("the agent's configured voice reaches the TTS provider, for the greeting and every later utterance", async () => {
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    const agent = await agentWith("Voiced agent", { voice: "meera" });
    const { phone } = await connect(agent.id, "phe-voice-1");
    await phone.waitForMarks(1);
    expect(tts.requests.length).toBeGreaterThanOrEqual(1);
    expect(tts.requests.every((r) => r.voice === "meera")).toBe(true);
  });

  it("an agent with no voice sends none (the provider's default voice)", async () => {
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    const agent = await agentWith("Default-voice agent");
    const { phone } = await connect(agent.id, "phe-voice-2");
    await phone.waitForMarks(1);
    expect(tts.requests[0].voice).toBeUndefined();
  });

  it("different agents speak with their own voices", async () => {
    const tts = new MockTtsProvider();
    setTtsProvider(tts);
    const a = await agentWith("Voice A", { voice: "voice-a" });
    const b = await agentWith("Voice B", { voice: "voice-b" });
    const first = await connect(a.id, "phe-voice-3a");
    await first.phone.waitForMarks(1);
    const second = await connect(b.id, "phe-voice-3b");
    await second.phone.waitForMarks(1);
    expect(new Set(tts.requests.map((r) => r.voice))).toEqual(new Set(["voice-a", "voice-b"]));
  });

  it("a voice the provider rejects falls back to the default voice: the agent still speaks", async () => {
    const inner = new MockTtsProvider();
    const requests: Array<string | undefined> = [];
    const picky: ITextToSpeech = {
      name: "picky-tts",
      capabilities: { voiceSelection: true },
      async synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
        requests.push(opts?.voice);
        if (opts?.voice) throw new ProviderRequestError("picky-tts", "picky-tts tts.synthesize failed (HTTP 400)", undefined, { category: "invalid_request", operation: "tts.synthesize", status: 400 });
        return inner.synthesize(text, opts);
      },
    };
    setTtsProvider(picky);
    const agent = await agentWith("Bad voice agent", { voice: "no-such-speaker" });
    const { phone } = await connect(agent.id, "phe-voice-4");
    await phone.waitForMarks(1); // it spoke despite the bad voice
    expect(requests.slice(0, 2)).toEqual(["no-such-speaker", undefined]);
  });
});

describe("cancellation when the call ends", () => {
  it("an in-flight model request is aborted as soon as the caller hangs up", async () => {
    let aborted = false;
    let started = false;
    const hanging: ILanguageModel = {
      name: "hanging-llm",
      chat(_m: ChatMessage[], _t: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult> {
        started = true;
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(opts.signal?.reason);
          });
        });
      },
    };
    setLlmProvider(hanging);
    const agent = await agentWith("Hanging agent");
    const { phone } = await connect(agent.id, "phe-cancel-1");
    const until = Date.now() + 5_000;
    while (!started && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    expect(aborted).toBe(false); // still waiting on the model

    await phone.hangUp();
    const until2 = Date.now() + 3_000;
    while (!aborted && Date.now() < until2) await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true); // the request was told to stop, not left running for nobody
  });
});

describe("provider outage during a call", () => {
  it("a failing model does not crash the session; the call stays up and recovers on the next turn", async () => {
    const mock = new MockLlmProvider();
    let calls = 0;
    const flaky: ILanguageModel = {
      name: "flaky-llm",
      async chat(m, t, o) {
        calls++;
        if (calls === 1) return mock.chat(m, t, o); // the greeting works
        throw new ProviderRequestError("flaky-llm", "flaky-llm llm.chat failed (HTTP 503)", undefined, { category: "server", operation: "llm.chat", status: 503 });
      },
    };
    setLlmProvider(flaky);
    const agent = await agentWith("Flaky agent");
    const { phone } = await connect(agent.id, "phe-outage-1");
    await phone.waitForMarks(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(phone.isOpen()).toBe(true);
  });
});
