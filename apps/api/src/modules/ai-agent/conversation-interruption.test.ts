/**
 * Conversation history after the caller interrupts (barge-in): the model must not believe it said what the caller
 * never heard, an unanswered caller message is not left dangling, and tool history stays valid. Real ConversationSession
 * and Postgres transcript, scripted model.
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.AI_PROVIDER = "mock";

import { ConversationSession } from "./conversation.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolCallRequest, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import type { ProviderCallOptions } from "../../adapters/ai/provider-common.js";
import { conversationsRepository } from "../../test/repos.js";
import { callsService } from "../calls/calls.service.js";
import { defaultAgentIdFor } from "../../test/tenants.js";
import { demoContext } from "../../test/helpers.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";
import type { RequestContext } from "../../auth/context.js";

/** Replies with canned text; a step can hang until its signal aborts (the caller interrupted the thinking). */
class Scripted implements ILanguageModel {
  readonly name = "scripted";
  readonly seen: ChatMessage[][] = [];
  private i = 0;
  constructor(private readonly steps: Array<{ text?: string; hang?: boolean; tool?: ToolCallRequest }>) {}
  async chat(messages: ChatMessage[], _t: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult> {
    this.seen.push(structuredClone(messages));
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    if (step.hang) {
      await new Promise<never>((_res, rej) => {
        const fail = () => rej(new DOMException("cancelled", "AbortError"));
        if (opts?.signal?.aborted) fail();
        else opts?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (step.tool) return { toolCalls: [step.tool] };
    return { content: step.text ?? "" };
  }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
};

let org: RequestContext;
let ctx: ToolExecutionContext;
const msgs = (s: ConversationSession) => (s as unknown as { messages: ChatMessage[] }).messages;
const roles = (s: ConversationSession) => msgs(s).map((m) => m.role);
const transcript = async () =>
  (((await conversationsRepository.findByCallId({ organizationId: org.organizationId, callId: ctx.callId }))?.transcript ?? []) as Array<{ speaker: string; text: string }>);

beforeAll(async () => {
  org = await demoContext();
  ctx = { organizationId: org.organizationId, callId: (await callsService.createCall(org, { agentId: await defaultAgentIdFor(org.organizationId), callType: "test" })).id };
});
const fresh = async () => {
  const call = await callsService.createCall(org, { agentId: await defaultAgentIdFor(org.organizationId), callType: "test" });
  ctx = { organizationId: org.organizationId, callId: call.id };
};

describe("history after an interruption", () => {
  it("interrupted while the model was still thinking: no assistant message, the next utterance joins the unanswered one", async () => {
    await fresh();
    const llm = new Scripted([{ text: "Hi." }, { hang: true }, { text: "Sure, both answered." }]);
    const s = new ConversationSession(llm, ctx, {}, undefined);
    await s.start();
    const ac = new AbortController();
    const turn = s.handleUserUtterance("What is the price?", { signal: ac.signal });
    await until(() => llm.seen.length === 2); // the model call (the hanging one) is in flight
    ac.abort(); // barge-in
    await expect(turn).rejects.toBeTruthy();
    expect(roles(s)).toEqual(["system", "user", "assistant", "user"]); // dangling user message, no assistant reply

    const reply = await s.handleUserUtterance("Actually, is parking included?");
    expect(reply.spokenText).toBe("Sure, both answered.");
    // Still strictly alternating, and the model sees BOTH of the caller's messages.
    expect(roles(s)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(msgs(s)[3].content).toBe("What is the price?\nActually, is parking included?");
    // The transcript keeps them as the two separate caller turns they were.
    expect((await transcript()).filter((t) => t.speaker === "lead").map((t) => t.text)).toEqual(["What is the price?", "Actually, is parking included?"]);
  });

  it("interrupted while the reply was being spoken: history keeps only what had been synthesized", async () => {
    await fresh();
    const full = "The project is in Pune. It has 2 and 3 BHK homes. Possession is in 2027.";
    const s = new ConversationSession(new Scripted([{ text: "Hi." }, { text: full }]), ctx, {}, undefined);
    await s.start();
    await s.handleUserUtterance("Tell me about it");
    s.noteInterrupted("The project is in Pune.");
    const last = msgs(s).at(-1)!;
    expect(last).toMatchObject({ role: "assistant", content: "The project is in Pune." });
    // Nothing heard at all: the reply is dropped, and the next caller message follows the previous one validly.
    s.noteInterrupted("");
    expect(roles(s)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("noteInterrupted never touches tool history or a reply that was fully spoken", async () => {
    await fresh();
    const call: ToolCallRequest = { id: "c1", name: "end_call", arguments: {} };
    const s = new ConversationSession(new Scripted([{ text: "Hi." }, { tool: call }, { text: "Goodbye." }]), ctx, {}, undefined);
    await s.start();
    await s.handleUserUtterance("bye");
    const before = structuredClone(msgs(s));
    s.noteInterrupted("Goodbye. And more words than were said"); // heard >= content: unchanged
    expect(msgs(s)).toEqual(before);
    // Last message is a plain reply here; a tool-call assistant message must never be altered.
    msgs(s).push({ role: "assistant", content: "", toolCalls: [call] });
    s.noteInterrupted("");
    expect(msgs(s).at(-1)?.toolCalls).toHaveLength(1);
  });

  it("interrupting the greeting keeps the call-connected instruction and merges the caller's first words into it", async () => {
    await fresh();
    const llm = new Scripted([{ hang: true }, { text: "Hello, how can I help?" }]);
    const s = new ConversationSession(llm, ctx, {}, undefined);
    const ac = new AbortController();
    const start = s.start({ signal: ac.signal });
    await until(() => llm.seen.length === 1);
    ac.abort();
    await expect(start).rejects.toBeTruthy();
    await s.handleUserUtterance("Hi, who is this?");
    expect(roles(s)).toEqual(["system", "user", "assistant"]);
    expect(msgs(s)[1].content).toContain("[Call connected");
    expect(msgs(s)[1].content).toContain("Hi, who is this?");
  });
});
