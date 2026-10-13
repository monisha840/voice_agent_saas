/**
 * What the model is shown across a call: tool history when it is offered no tools (Sarvam rejects that), and a reminder
 * of what the agent has already said and asked. Scripted model, real session and tools; no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ConversationSession, alreadySaidNote } from "./conversation.js";
import { fixedLine } from "./fallback-lines.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { cleanupTenants, createTenant } from "../../test/tenants.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";

let toolCtx: ToolExecutionContext;

beforeAll(async () => {
  const tenant = await createTenant("CONT_A");
  const call = await callsRepository.create({ organizationId: tenant.orgId, status: "in_progress", callType: "test", agentId: tenant.agentId });
  toolCtx = { organizationId: tenant.orgId, callId: call.id, agentId: tenant.agentId, callType: "test" };
});

afterAll(async () => {
  await cleanupTenants();
});

/** Behaves like Sarvam: a request that carries tool calls or tool results but defines no tools is refused. */
function strictScripted(script: ChatResult[]) {
  const requests: Array<{ messages: ChatMessage[]; tools: ToolDefinition[]; toolChoice?: string }> = [];
  const llm: ILanguageModel = {
    name: "strict-scripted",
    async chat(messages, tools, opts) {
      requests.push({ messages: messages.map((m) => ({ ...m })), tools, toolChoice: opts?.toolChoice });
      const hasToolHistory = messages.some((m) => m.role === "tool" || (m.toolCalls?.length ?? 0) > 0);
      if (tools.length === 0 && hasToolHistory) throw new Error("Tool messages found but no tools provided");
      return script.shift() ?? { content: "ok" };
    },
  };
  return { llm, requests };
}

describe("the request that follows end_call", () => {
  it("keeps the tools and the tool results, and tells the model to answer in words (tool_choice none)", async () => {
    const { llm, requests } = strictScripted([
      { toolCalls: [{ id: "p1", name: "get_project_details", arguments: {} }, { id: "e1", name: "end_call", arguments: {} }] },
      { content: "Thank you, goodbye." },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const result = await session.handleUserUtterance("ok that's all, bye");
    expect(result).toMatchObject({ spokenText: "Thank you, goodbye.", shouldEndCall: true });
    expect(requests).toHaveLength(2);
    expect(requests[0].toolChoice).toBeUndefined();
    expect(requests[1].toolChoice).toBe("none");
    expect(requests[1].tools.map((t) => t.name)).toContain("end_call"); // still defined: the provider needs them
    expect(requests[1].messages.filter((m) => m.role === "tool")).toHaveLength(2); // the results are the real ones
  });

  it("does not run tools a provider returns despite tool_choice none; the words that came with them are the reply", async () => {
    const { llm, requests } = strictScripted([
      { toolCalls: [{ id: "e1", name: "end_call", arguments: {} }] },
      { content: "Bye then.", toolCalls: [{ id: "e2", name: "end_call", arguments: {} }] },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const result = await session.handleUserUtterance("bye");
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ spokenText: "Bye then.", shouldEndCall: true });
  });
});

describe("a call that is ending is never left in silence", () => {
  it("uses the goodbye the model put inside end_call when it said nothing in its reply", async () => {
    const { llm } = strictScripted([
      { toolCalls: [{ id: "e1", name: "end_call", arguments: { message: "Noted, I will arrange a call tomorrow at 5. Goodbye!" } }] },
      { content: "" },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("call me tomorrow at 5, bye");
    expect(r).toMatchObject({ spokenText: "Noted, I will arrange a call tomorrow at 5. Goodbye!", shouldEndCall: true });
  });

  it("falls back to a fixed goodbye in the call's language", async () => {
    const { llm } = strictScripted([{ toolCalls: [{ id: "e1", name: "end_call", arguments: {} }] }, { content: "  " }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("சரி bye", { replyLanguage: "Tamil" });
    expect(r.shouldEndCall).toBe(true);
    expect(r.spokenText).toBe(fixedLine("goodbye", "ta-IN"));
    expect(r.spokenText).toMatch(/[஀-௿]/);
  });
});

describe("the reminder of what was already said", () => {
  it("is absent before the agent has said anything", () => {
    expect(alreadySaidNote([{ role: "system", content: "prompt" }, { role: "user", content: "[Call connected.]" }])).toBeNull();
  });

  it("lists the questions already asked and the last reply", () => {
    const note = alreadySaidNote([
      { role: "system", content: "prompt" },
      { role: "assistant", content: "Hi, this is Priya. Is this a good time? I am calling about Green Valley." },
      { role: "user", content: "yes" },
      { role: "assistant", content: "Great. Which configuration do you need, 2 BHK or 3 BHK? Do you need a loan?" },
    ])!;
    expect(note).toContain("Your last reply was");
    expect(note).toContain("1. Is this a good time?");
    expect(note).toContain("2. Which configuration do you need, 2 BHK or 3 BHK?");
    expect(note).toContain("3. Do you need a loan?");
  });

  it("keeps only the latest questions and ignores tool-request messages", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "prompt" }];
    for (let i = 1; i <= 9; i++) messages.push({ role: "assistant", content: `Question number ${i} here?` });
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: "t", name: "end_call", arguments: {} }] });
    const note = alreadySaidNote(messages)!;
    expect(note).not.toContain("number 1 here");
    expect(note).toContain("number 9 here");
    expect(note.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(6);
  });

  it("reaches the model on the next turn without being stored", async () => {
    const { llm, requests } = strictScripted([{ content: "Is this a good time?" }, { content: "Great, which configuration?" }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.start();
    await session.handleUserUtterance("yes");
    const sent = requests[1].messages;
    expect(sent.at(-1)).toEqual({ role: "user", content: "yes" }); // the caller's words stay last, unmodified
    const note = sent.at(-2)!;
    expect(note.role).toBe("system");
    expect(String(note.content)).toContain("Is this a good time?");
    // The first request (the greeting) had no reminder, and the note is not part of any later history either.
    expect(requests[0].messages.some((m) => String(m.content).includes("Do not repeat yourself"))).toBe(false);
  });
});
