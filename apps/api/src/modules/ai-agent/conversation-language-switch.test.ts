/**
 * What happens in the session when a caller asks for another language, and when the model gets stuck asking for tools.
 * Scripted model, real session and tools; no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ConversationSession } from "./conversation.js";
import { fallbackLine } from "./fallback-lines.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { cleanupTenants, createTenant } from "../../test/tenants.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";

let toolCtx: ToolExecutionContext;

beforeAll(async () => {
  const tenant = await createTenant("LSW_A");
  const call = await callsRepository.create({ organizationId: tenant.orgId, status: "in_progress", callType: "test", agentId: tenant.agentId });
  toolCtx = { organizationId: tenant.orgId, callId: call.id, agentId: tenant.agentId, callType: "test" };
});

afterAll(async () => {
  await cleanupTenants();
});

function scripted(script: ChatResult[]) {
  const requests: Array<{ messages: ChatMessage[]; tools: ToolDefinition[]; toolChoice?: string }> = [];
  const llm: ILanguageModel = {
    name: "scripted",
    async chat(messages, tools, opts) {
      requests.push({ messages: messages.map((m) => ({ ...m })), tools, toolChoice: opts?.toolChoice });
      return script.shift() ?? { content: "ok" };
    },
  };
  return { llm, requests };
}

describe("an explicit language request", () => {
  it("is passed to the model as an override of earlier language instructions, for that turn only", async () => {
    const { llm, requests } = scripted([{ content: "Sure." }, { content: "Fine." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("Could you please speak in English?", { replyLanguage: "English", languageRequested: true });
    const hint = requests[0].messages.at(-1)!;
    expect(hint.role).toBe("system");
    expect(String(hint.content)).toContain("asked you to speak English");
    expect(String(hint.content)).toContain("overrides every earlier instruction");

    await session.handleUserUtterance("3 BHK");
    expect(requests[1].messages.some((m) => String(m.content).includes("asked you to speak"))).toBe(false);
  });
});

describe("end_call", () => {
  it("once it has run, the model is told to choose no tool, so it cannot loop on end_call", async () => {
    const { llm, requests } = scripted([
      { toolCalls: [{ id: "e1", name: "end_call", arguments: {} }] },
      { content: "Thank you, goodbye." },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const result = await session.handleUserUtterance("ok bye");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((t) => t.name)).toContain("end_call");
    expect(requests[1].toolChoice).toBe("none");
    expect(result).toMatchObject({ spokenText: "Thank you, goodbye.", shouldEndCall: true });
  });
});

describe("the fallback line", () => {
  it("follows the call's language when the model never produces words", async () => {
    const { llm } = scripted(
      Array.from({ length: 6 }, (_, i) => ({ toolCalls: [{ id: `t${i}`, name: "get_project_details", arguments: {} }] })),
    );
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const result = await session.handleUserUtterance("tell me more", { replyLanguage: "Tamil" });
    expect(result.spokenText).toBe(fallbackLine("ta-IN"));
    expect(result.shouldEndCall).toBe(true);
  });

  it("is English for English and for anything unknown", () => {
    expect(fallbackLine("en-IN")).toContain("colleague");
    expect(fallbackLine("English")).toBe(fallbackLine("en-IN"));
    expect(fallbackLine(undefined)).toBe(fallbackLine("en-IN"));
    expect(fallbackLine("xx-YY")).toBe(fallbackLine("en-IN"));
    expect(fallbackLine("Tamil")).not.toBe(fallbackLine("en-IN"));
  });
});
