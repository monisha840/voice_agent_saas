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

  it("falls back to a plain acknowledgement in the call's language: the goodbye is said only after the line has stayed quiet", async () => {
    const { llm } = strictScripted([{ toolCalls: [{ id: "e1", name: "end_call", arguments: {} }] }, { content: "  " }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("சரி bye", { replyLanguage: "Tamil" });
    expect(r.shouldEndCall).toBe(true);
    expect(r.spokenText).toBe(fixedLine("noted", "ta-IN"));
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

describe("going round in circles", () => {
  const SAME = "I am an AI assistant, would you like to see the visit slots for this Saturday?";

  it("a repeated reply makes the next request carry a note to change tack", async () => {
    const { llm, requests } = strictScripted([{ content: SAME }, { content: SAME }, { content: "Okay, the 2 BHK is 65 to 78 lakhs." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("who is this");
    expect(requests[0].messages.some((m) => String(m.content).includes("You have just repeated yourself"))).toBe(false);
    await session.handleUserUtterance("but what is your name");
    // The second reply repeated the first; the third request is told.
    expect(requests[1].messages.some((m) => String(m.content).includes("You have just repeated yourself"))).toBe(false);
    await session.handleUserUtterance("price?");
    expect(requests[2].messages.some((m) => String(m.content).includes("You have just repeated yourself"))).toBe(true);
  });

  it("a note is not kept once the agent says something new", async () => {
    const { llm, requests } = strictScripted([{ content: SAME }, { content: SAME }, { content: "The 2 BHK is 65 to 78 lakhs, floor and facing change it." }, { content: "Saturday has 10 and 11:30." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("one");
    await session.handleUserUtterance("two");
    await session.handleUserUtterance("three");
    await session.handleUserUtterance("four");
    expect(requests[3].messages.some((m) => String(m.content).includes("You have just repeated yourself"))).toBe(false);
  });

  it("after the agent has repeated itself three times in a row it wraps the call up", async () => {
    const { llm, requests } = strictScripted([
      { content: SAME },
      { content: SAME },
      { content: SAME },
      { content: SAME },
      { content: "The team will call you shortly. Thank you, goodbye." },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    for (const t of ["a", "b", "c", "d"]) {
      const r = await session.handleUserUtterance(t);
      expect(r.shouldEndCall).toBe(false);
    }
    const closing = await session.handleUserUtterance("e");
    expect(closing).toMatchObject({ spokenText: "The team will call you shortly. Thank you, goodbye.", shouldEndCall: true });
    expect(requests[4].toolChoice).toBe("none");
  });
});

describe("a goodbye that was only said", () => {
  it("a reply announcing the call is closed ends the call, even though end_call was not called", async () => {
    const { llm } = strictScripted([{ content: "I have closed the call now. Thank you, goodbye." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("hmm");
    expect(r.shouldEndCall).toBe(true);
  });

  it("an offer to close it does not", async () => {
    const { llm } = strictScripted([{ content: "Shall I close the call, or is there anything else?" }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("hmm");
    expect(r.shouldEndCall).toBe(false);
  });
});

describe("words that were not meant for the agent", () => {
  it("the model answers SILENT: nothing is spoken, and the words leave the history and the record", async () => {
    const { llm, requests } = strictScripted([{ content: "Hello, this is Priya." }, { content: "SILENT" }, { content: "The 2 BHK is 65 to 78 lakhs." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.start();
    const r = await session.handleUserUtterance("arre yaar picture chalo jaldi");
    expect(r).toMatchObject({ spokenText: "", shouldEndCall: false, silent: true });
    await session.handleUserUtterance("what is the price");
    const seen = requests[2].messages.map((m) => String(m.content));
    expect(seen.some((c) => c.includes("picture chalo"))).toBe(false); // the model never sees it again
    expect(seen.some((c) => c.includes("what is the price"))).toBe(true);
  });

  it("is also recognised with punctuation or brackets, in any case", async () => {
    for (const reply of ["SILENT", "silent.", "[SILENT]", "  Silent  "]) {
      const { llm } = strictScripted([{ content: reply }]);
      const session = new ConversationSession(llm, toolCtx, {}, undefined);
      expect((await session.handleUserUtterance("noise")).silent).toBe(true);
    }
  });

  it("only the bare word counts: a sentence that contains it is a reply", async () => {
    const { llm } = strictScripted([{ content: "It is quiet here, silent as a library." }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("how is the place");
    expect(r.silent).toBeUndefined();
    expect(r.spokenText).toContain("silent as a library");
  });

  it("after two silences in a row the next is not trusted: a real caller is asked to repeat", async () => {
    const { llm } = strictScripted([{ content: "SILENT" }, { content: "SILENT" }, { content: "SILENT" }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    expect((await session.handleUserUtterance("a")).silent).toBe(true);
    expect((await session.handleUserUtterance("b")).silent).toBe(true);
    const third = await session.handleUserUtterance("c");
    expect(third.silent).toBeUndefined();
    expect(third.spokenText).toBe(fixedLine("retry", "en-IN"));
  });

  it("is never applied to the call's own goodbye", async () => {
    const { llm } = strictScripted([{ toolCalls: [{ id: "e", name: "end_call", arguments: {} }] }, { content: "SILENT" }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    const r = await session.handleUserUtterance("bye");
    expect(r.silent).toBeUndefined();
    expect(r.shouldEndCall).toBe(true);
    expect(r.spokenText.length).toBeGreaterThan(0);
  });
});

describe("a question the caller did not answer is not asked again word for word", () => {
  const Q = "When are you planning to buy, and will you need a home loan?";

  it("the repeat is dropped from the reply and from what is stored", async () => {
    const { llm, requests } = strictScripted([
      { content: `Great. ${Q}` },
      { content: `I am an AI assistant. ${Q}` },
      { content: "Okay." },
    ]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("yes");
    const second = await session.handleUserUtterance("who are you");
    expect(second.spokenText).toBe("I am an AI assistant.");
    await session.handleUserUtterance("ok");
    const stored = requests[2].messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(stored.at(-1)).toBe("I am an AI assistant.");
  });

  it("a reply that is nothing but the repeated question is kept rather than made silent", async () => {
    const { llm } = strictScripted([{ content: `Great. ${Q}` }, { content: Q }]);
    const session = new ConversationSession(llm, toolCtx, {}, undefined);
    await session.handleUserUtterance("yes");
    const second = await session.handleUserUtterance("hmm");
    expect(second.spokenText).toBe(Q);
  });
});

