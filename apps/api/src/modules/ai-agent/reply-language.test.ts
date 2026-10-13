import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectReplyLanguage, replyLanguageName } from "./reply-language.js";
import { ConversationSession } from "./conversation.js";
import type { ChatMessage, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { cleanupTenants, createTenant } from "../../test/tenants.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";

describe("detectReplyLanguage", () => {
  it("Tamil script is Tamil", () => {
    expect(detectReplyLanguage("இந்த இரண்டு பிஹெச்கே விலை எவ்வளவு?")).toBe("ta-IN");
  });

  it("Tamil mixed with English words is still Tamil", () => {
    expect(detectReplyLanguage("Site visit-க்கு Sunday evening 5 மணிக்கு possible-ஆ?")).toBe("ta-IN");
  });

  it("other Indian scripts map to their language", () => {
    expect(detectReplyLanguage("मुझे दो बीएचके का दाम बताइए")).toBe("hi-IN");
    expect(detectReplyLanguage("నాకు రెండు బెడ్ రూమ్ ధర చెప్పండి")).toBe("te-IN");
  });

  it("plain English is English", () => {
    expect(detectReplyLanguage("What is the price of the two bedroom apartment?")).toBe("en-IN");
  });

  it("a Latin-script utterance takes the provider's label when it names a supported language", () => {
    expect(detectReplyLanguage("mujhe do bedroom ka rate batao", "hi-IN")).toBe("hi-IN");
    expect(detectReplyLanguage("mujhe do bedroom ka rate batao", "xx-YY")).toBe("en-IN");
  });

  it("very short utterances never switch the language", () => {
    expect(detectReplyLanguage("ok")).toBeNull();
    expect(detectReplyLanguage("சரி")).toBeNull();
    expect(detectReplyLanguage("   ")).toBeNull();
  });

  it("digits and punctuation alone decide nothing", () => {
    expect(detectReplyLanguage("11:30 , 2 ?")).toBeNull();
  });

  it("names the language for the model", () => {
    expect(replyLanguageName("ta-IN")).toBe("Tamil");
    expect(replyLanguageName("en-IN")).toBe("English");
    expect(replyLanguageName("zz-ZZ")).toBeUndefined();
  });
});

describe("the session's one-turn language hint", () => {
  function spy() {
    const seen: ChatMessage[][] = [];
    const llm: ILanguageModel = {
      name: "spy",
      async chat(messages: ChatMessage[], _tools: ToolDefinition[]) {
        seen.push(messages.map((m) => ({ ...m })));
        return { content: "ok" };
      },
    };
    return { llm, seen };
  }
  let toolCtx: ToolExecutionContext;

  beforeAll(async () => {
    const tenant = await createTenant("RL_A");
    const call = await callsRepository.create({ organizationId: tenant.orgId, status: "in_progress", callType: "test", agentId: tenant.agentId });
    toolCtx = { organizationId: tenant.orgId, callId: call.id, agentId: tenant.agentId, callType: "test" };
  });

  afterAll(async () => {
    await cleanupTenants();
  });

  it("adds the hint to that turn's request only, and never to the stored history", async () => {
    const { llm, seen } = spy();
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("இந்த 2 BHK விலை எவ்வளவு?", { replyLanguage: "Tamil" });
    const hinted = seen[0];
    expect(hinted.at(-1)).toEqual({ role: "system", content: expect.stringContaining("Tamil") });

    await session.handleUserUtterance("And the location?");
    const next = seen[1];
    expect(next.some((m) => m.role === "system" && String(m.content).includes("The caller is speaking"))).toBe(false);
  });

  it("without a language the request is exactly the history", async () => {
    const { llm, seen } = spy();
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("hello there");
    expect(seen[0].filter((m) => m.role === "system")).toHaveLength(1); // only the system prompt
  });
});
