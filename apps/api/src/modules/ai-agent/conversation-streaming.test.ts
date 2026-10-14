/**
 * ConversationSession with a STREAMING model: chunk hand-off, metrics notifications, and above all that history, tools
 * and cancellation behave exactly as they do for the batch model. Scripted streaming provider, real (test) tools,
 * real Postgres for the transcript.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

process.env.AI_PROVIDER = "mock";

import { ConversationSession, ConversationCancelledError, type TextChunk } from "./conversation.js";
import { registerTool, unregisterTool } from "../../ai-tools/index.js";
import type { AiTool, ToolExecutionContext } from "../../ai-tools/types.js";
import type { ChatMessage, ChatResult, ILanguageModel, LlmStreamHandlers, ToolCallRequest, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import type { ProviderCallOptions } from "../../adapters/ai/provider-common.js";
import { ProviderRequestError } from "../../shared/errors.js";
import { conversationsRepository } from "../../test/repos.js";
import { callsService } from "../calls/calls.service.js";
import { defaultAgentIdFor } from "../../test/tenants.js";
import { demoContext } from "../../test/helpers.js";
import type { RequestContext } from "../../auth/context.js";

interface Step {
  /** Text deltas delivered before the result. */
  deltas?: string[];
  /** After the deltas, wait for the signal to abort and fail like a cancelled provider call (a stream cut mid-way). */
  hang?: boolean;
  /** Fail (after the deltas) with this error. */
  fail?: Error;
  result?: ChatResult | ((messages: ChatMessage[]) => ChatResult);
}

class ScriptedStreamingLlm implements ILanguageModel {
  readonly name = "scripted-stream";
  readonly capabilities = { toolCalling: true, streamingLlm: true };
  readonly seen: ChatMessage[][] = [];
  streamCalls = 0;
  batchCalls = 0;
  lastOpts?: ProviderCallOptions;
  private i = 0;
  constructor(private readonly script: Step[]) {}

  private next(): Step {
    return this.script[Math.min(this.i++, this.script.length - 1)];
  }
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.batchCalls++;
    this.seen.push(structuredClone(messages));
    const step = this.next();
    return typeof step.result === "function" ? step.result(messages) : (step.result ?? { content: (step.deltas ?? []).join("") });
  }
  async chatStream(messages: ChatMessage[], _tools: ToolDefinition[], handlers: LlmStreamHandlers, opts?: ProviderCallOptions): Promise<ChatResult> {
    this.streamCalls++;
    this.lastOpts = opts;
    this.seen.push(structuredClone(messages));
    const step = this.next();
    for (const d of step.deltas ?? []) {
      await Promise.resolve();
      handlers.onTextDelta(d);
    }
    if (step.hang) {
      await new Promise<never>((_res, rej) => {
        const fail = () => rej(new ProviderRequestError("scripted", "cancelled", undefined, { category: "cancelled", operation: "llm.stream" }));
        if (opts?.signal?.aborted) fail();
        else opts?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (step.fail) throw step.fail;
    if (typeof step.result === "function") return step.result(messages);
    return step.result ?? { content: (step.deltas ?? []).join(""), finishReason: "stop" };
  }
}

const tc = (id: string, name: string, args: Record<string, unknown> = {}, extra: Partial<ToolCallRequest> = {}): ToolCallRequest => ({ id, name, arguments: args, ...extra });
const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
const makeTool = (name: string, run: (a: Record<string, unknown>) => unknown): AiTool => ({
  definition: { name, description: name, parameters: { type: "object", properties: {} } },
  async execute(args) {
    executed.push({ name, args });
    return run(args);
  },
});

function assertValidToolHistory(messages: ChatMessage[]) {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) {
      expect(declared.has(c.id)).toBe(false);
      declared.add(c.id);
    }
    if (m.role === "tool") {
      expect(declared.has(m.toolCallId ?? "")).toBe(true);
      expect(answered.has(m.toolCallId!)).toBe(false);
      answered.add(m.toolCallId!);
    }
  }
  for (const id of declared) expect(answered.has(id)).toBe(true);
}

let org: RequestContext;
let ctx: ToolExecutionContext;
const msgs = (s: ConversationSession) => (s as unknown as { messages: ChatMessage[] }).messages;
const sessionFor = (llm: ILanguageModel, streaming = true) => new ConversationSession(llm, ctx, {}, undefined, { streaming });
const transcript = async () =>
  (((await conversationsRepository.findByCallId({ organizationId: org.organizationId, callId: ctx.callId }))?.transcript ?? []) as Array<{ speaker: string; text: string }>);

beforeAll(async () => {
  org = await demoContext();
  const call = await callsService.createCall(org, { agentId: await defaultAgentIdFor(org.organizationId), callType: "test" });
  ctx = { organizationId: org.organizationId, callId: call.id };
  registerTool(makeTool("zz_lookup", (a) => ({ found: true, item: a.item ?? null })));
  registerTool(makeTool("zz_reserve", (a) => ({ reserved: true, item: a.item ?? null })));
});
afterAll(() => {
  unregisterTool("zz_lookup");
  unregisterTool("zz_reserve");
});
afterEach(() => {
  executed.length = 0;
});

describe("streaming reply: chunks, assembly and history", () => {
  it("groups deltas into sentence chunks as they complete and assembles the full reply", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { deltas: ["Hello", " Rajesh", ". I", " can", " help", " you", " with", " that."] },
    ]);
    const s = sessionFor(llm);
    await s.start();
    const seen: TextChunk[] = [];
    const turn = await s.handleUserUtterance("Can you help?", { onTextChunk: (c) => void seen.push(c) });
    expect(turn.spokenText).toBe("Hello Rajesh. I can help you with that.");
    expect(turn.chunks).toEqual(["Hello Rajesh.", "I can help you with that."]);
    expect(seen).toEqual([
      { text: "Hello Rajesh.", hop: 0, index: 0 },
      { text: "I can help you with that.", hop: 0, index: 1 },
    ]);
    expect(turn.shouldEndCall).toBe(false);
    expect(llm.streamCalls).toBe(2);
    expect(llm.batchCalls).toBe(0);
  });

  it("emits the first chunk while the model is still generating (before the request completes)", async () => {
    let releaseTail!: () => void;
    const tail = new Promise<void>((r) => (releaseTail = r));
    const llm = new ScriptedStreamingLlm([{ deltas: ["Opening."] }]);
    llm["script"].push({ deltas: [] });
    llm.chatStream = async (_m, _t, handlers) => {
      handlers.onTextDelta("The price starts at a good value. ");
      await tail; // the model is still "thinking" about the rest
      handlers.onTextDelta("It includes parking.");
      return { content: "The price starts at a good value. It includes parking.", finishReason: "stop" };
    };
    const s = sessionFor(llm);
    const early: string[] = [];
    const done = s.handleUserUtterance("price?", { onTextChunk: (c) => void early.push(c.text) });
    await new Promise((r) => setTimeout(r, 20));
    expect(early).toEqual(["The price starts at a good value."]); // delivered before completion
    releaseTail();
    const turn = await done;
    expect(turn.chunks).toEqual(["The price starts at a good value.", "It includes parking."]);
  });

  it("history: one user message and exactly one assistant message, written only after completion; transcript likewise", async () => {
    const before = (await transcript()).length;
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hello."] }, { deltas: ["Sure, ", "the answer ", "is yes."] }]);
    const s = sessionFor(llm);
    await s.start();
    const turn = await s.handleUserUtterance("Is it ready?");
    const m = msgs(s);
    expect(m.filter((x) => x.role === "user" && x.content === "Is it ready?").length).toBe(1);
    const assistants = m.filter((x) => x.role === "assistant");
    expect(assistants.map((a) => a.content)).toEqual(["Hello.", "Sure, the answer is yes."]); // opening + this reply, never per-token
    expect(turn.spokenText).toBe("Sure, the answer is yes.");
    const t = (await transcript()).slice(before);
    expect(t.map((x) => [x.speaker, x.text])).toEqual([
      ["ai", "Hello."],
      ["lead", "Is it ready?"],
      ["ai", "Sure, the answer is yes."],
    ]);
  });

  it("an empty reply is an empty turn: no chunks, nothing stored as the assistant's words", async () => {
    const before = (await transcript()).length;
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }, { deltas: [], result: { content: "", finishReason: "stop" } }]);
    const s = sessionFor(llm);
    await s.start();
    const turn = await s.handleUserUtterance("hello?");
    expect(turn.spokenText).toBe("");
    expect(turn.chunks).toEqual([]);
    expect((await transcript()).slice(before).map((x) => x.speaker)).toEqual(["ai", "lead"]); // no "ai" entry for the empty reply
  });

  it("batch sessions are untouched: no streaming call, no chunks", async () => {
    const llm = new ScriptedStreamingLlm([{ result: { content: "Hi." } }, { result: { content: "A batch answer." } }]);
    const s = sessionFor(llm, false);
    await s.start();
    const turn = await s.handleUserUtterance("q");
    expect(turn).toEqual({ spokenText: "A batch answer.", shouldEndCall: false });
    expect(llm.streamCalls).toBe(0);
    expect(llm.batchCalls).toBe(2);
  });

  it("a streaming session over a provider that cannot stream falls back to batch", async () => {
    const batchOnly: ILanguageModel = { name: "batch-only", chat: async () => ({ content: "plain reply." }) };
    const s = sessionFor(batchOnly, true);
    const turn = await s.handleUserUtterance("q");
    expect(turn.spokenText).toBe("plain reply.");
    expect(turn.chunks).toBeUndefined();
  });

  it("passes the turn's signal and the call id to the provider", async () => {
    const llm = new ScriptedStreamingLlm([{ deltas: ["ok."] }]);
    const ac = new AbortController();
    await sessionFor(llm).handleUserUtterance("q", { signal: ac.signal });
    expect(llm.lastOpts?.signal).toBe(ac.signal);
    expect(llm.lastOpts?.callId).toBe(ctx.callId);
  });
});

describe("streaming reply: metrics notifications (timings and counts only)", () => {
  it("reports request start, first token, first chunk and hop completion in order, without any text", async () => {
    const events: string[] = [];
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hello", " there. How", " are you?"], result: { content: "Hello there. How are you?", finishReason: "stop", usage: { completionTokens: 7 } } }]);
    await sessionFor(llm).handleUserUtterance("hi", {
      observer: {
        onRequestStart: (h) => void events.push(`start:${h}`),
        onFirstToken: (h) => void events.push(`token:${h}`),
        onFirstChunk: (h) => void events.push(`chunk:${h}`),
        onHopComplete: (e) => void events.push(`done:${JSON.stringify(e)}`),
      },
    });
    expect(events.slice(0, 3)).toEqual(["start:0", "token:0", "chunk:0"]);
    expect(JSON.parse(events[3].slice(5))).toEqual({ hop: 0, toolCalls: 0, chars: 25, chunks: 2, streamed: true, finishReason: "stop", completionTokens: 7 });
    expect(events.join("|")).not.toContain("Hello"); // no content leaks into notifications
  });
});

describe("streaming reply: tools", () => {
  it("a tool call is executed once the stream has produced it; its result continues the conversation and the final hop is the reply", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { deltas: ["Let me check that. "], result: { toolCalls: [tc("call_A", "zz_lookup", { item: "2 BHK" })], finishReason: "tool_calls" } },
      {
        deltas: ["Yes, ", "it is available."],
        result: (m) => {
          const tool = m.filter((x) => x.role === "tool").at(-1)!;
          expect(tool.toolCallId).toBe("call_A");
          expect(JSON.parse(tool.content)).toEqual({ found: true, item: "2 BHK" });
          return { content: "Yes, it is available.", finishReason: "stop" };
        },
      },
    ]);
    const s = sessionFor(llm);
    await s.start();
    const chunks: TextChunk[] = [];
    const turn = await s.handleUserUtterance("Do you have a 2 BHK?", { onTextChunk: (c) => void chunks.push(c) });
    expect(executed).toEqual([{ name: "zz_lookup", args: { item: "2 BHK" } }]);
    expect(turn.spokenText).toBe("Yes, it is available.");
    expect(turn.chunks).toEqual(["Yes, it is available."]); // the preamble before the tool call is not part of the reply
    expect(chunks.map((c) => c.hop)).toEqual([0, 1]); // hop 0 was the preamble (flagged by its hop index), hop 1 the reply
    assertValidToolHistory(msgs(s));
    expect(msgs(s).filter((x) => x.role === "assistant" && !x.toolCalls).map((a) => a.content)).toEqual(["Hi.", "Yes, it is available."]);
  });

  it("multi-tool sequence over streamed hops: each tool runs once, in order, history stays valid", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { result: { toolCalls: [tc("c1", "zz_lookup", { item: "A" }), tc("c2", "zz_lookup", { item: "B" })], finishReason: "tool_calls" } },
      { result: { toolCalls: [tc("c3", "zz_reserve", { item: "A" })], finishReason: "tool_calls" } },
      { deltas: ["Done."], result: { content: "Done.", finishReason: "stop" } },
    ]);
    const s = sessionFor(llm);
    await s.start();
    const turn = await s.handleUserUtterance("reserve A after checking A and B");
    expect(executed.map((e) => `${e.name}:${e.args.item}`)).toEqual(["zz_lookup:A", "zz_lookup:B", "zz_reserve:A"]);
    expect(turn.spokenText).toBe("Done.");
    assertValidToolHistory(msgs(s));
  });

  it("duplicate tool calls in one streamed response run once", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { result: { toolCalls: [tc("dup", "zz_reserve", { item: "X" }), tc("dup", "zz_reserve", { item: "X" })], finishReason: "tool_calls" } },
      { deltas: ["Reserved."], result: { content: "Reserved." } },
    ]);
    const s = sessionFor(llm);
    await s.start();
    await s.handleUserUtterance("reserve X");
    expect(executed.length).toBe(1);
    assertValidToolHistory(msgs(s));
  });

  it("garbled tool arguments from the stream are not executed; the model is told and recovers", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { result: { toolCalls: [tc("bad", "zz_reserve", {}, { invalidArguments: true })], finishReason: "tool_calls" } },
      { deltas: ["Sorry, trying again."], result: { content: "Sorry, trying again." } },
    ]);
    const s = sessionFor(llm);
    await s.start();
    const turn = await s.handleUserUtterance("reserve");
    expect(executed).toEqual([]);
    expect(turn.spokenText).toBe("Sorry, trying again.");
    const result = msgs(s).find((m) => m.role === "tool")!;
    expect(JSON.parse(result.content).error).toMatch(/not valid/);
  });
});

describe("streaming reply: cancellation and failure", () => {
  it("a turn cancelled mid-stream stores no assistant message, runs no tool, and leaves the user's message as before", async () => {
    const before = (await transcript()).length;
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }, { deltas: ["Our price is "], hang: true }]);
    const s = sessionFor(llm);
    await s.start();
    const ac = new AbortController();
    const chunks: string[] = [];
    const p = s.handleUserUtterance("price?", { signal: ac.signal, onTextChunk: (c) => void chunks.push(c.text) });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toSatisfy((e) => e instanceof ProviderRequestError || e instanceof ConversationCancelledError);
    const m = msgs(s);
    expect(m.at(-1)).toEqual({ role: "user", content: "price?" }); // the partial reply was never recorded
    expect(m.filter((x) => x.role === "assistant").map((a) => a.content)).toEqual(["Hi."]);
    expect(executed).toEqual([]);
    expect((await transcript()).slice(before).map((x) => x.speaker)).toEqual(["ai", "lead"]);
    expect(chunks).toEqual([]); // "Our price is " never completed a sentence
  });

  it("cancelled while a tool call is being assembled: the tool never runs and no tool/assistant messages appear", async () => {
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }, { hang: true }]);
    const s = sessionFor(llm);
    await s.start();
    const ac = new AbortController();
    const p = s.handleUserUtterance("reserve", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toBeDefined();
    expect(executed).toEqual([]);
    expect(msgs(s).filter((x) => x.role === "tool" || x.toolCalls)).toEqual([]);
  });

  it("text delivered after the abort is dropped and no further chunks are emitted", async () => {
    const ac = new AbortController();
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }]);
    llm.chatStream = async (_m, _t, handlers) => {
      handlers.onTextDelta("First sentence here. ");
      ac.abort();
      handlers.onTextDelta("Second sentence after abort. ");
      throw new ProviderRequestError("scripted", "cancelled", undefined, { category: "cancelled", operation: "llm.stream" });
    };
    const got: string[] = [];
    await expect(sessionFor(llm).handleUserUtterance("q", { signal: ac.signal, onTextChunk: (c) => void got.push(c.text) })).rejects.toBeDefined();
    expect(got).toEqual(["First sentence here."]);
  });

  it("a stream that fails after some text leaves no half reply; the next utterance works on a valid history", async () => {
    const llm = new ScriptedStreamingLlm([
      { deltas: ["Hi."] },
      { deltas: ["Part of a rep"], fail: new ProviderRequestError("scripted", "dropped", undefined, { category: "network", operation: "llm.stream" }) },
      { deltas: ["Second try works."] },
    ]);
    const s = sessionFor(llm);
    await s.start();
    await expect(s.handleUserUtterance("first")).rejects.toBeInstanceOf(ProviderRequestError);
    expect(msgs(s).filter((x) => x.role === "assistant").map((a) => a.content)).toEqual(["Hi."]);
    const turn = await s.handleUserUtterance("second");
    expect(turn.spokenText).toBe("Second try works.");
    // The unanswered "first" is not left dangling: the new words join it, so roles still alternate and the model answers both.
    expect(msgs(s).filter((x) => x.role === "user" && x.content.endsWith("second")).length).toBe(1);
    expect(msgs(s).map((x) => x.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(msgs(s)[3].content).toBe("first\nsecond");
  });
});

describe("languages (the model sees what the caller said, unmodified)", () => {
  it.each([
    ["English", "Can you tell me the price for a two bedroom apartment?", "Certainly, I can help. The price starts at a good value."],
    ["Tamil", "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?", "நிச்சயமாக. விலை 70 லட்சத்தில் தொடங்குகிறது."],
    ["Tanglish", "Indha project la 2 BHK price evlo?", "Sure, naan help panren. Price romba nalla value la start aagudhu."],
  ])("%s", async (_n, user, reply) => {
    const words = reply.split(/(?<= )/);
    const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }, { deltas: words }]);
    const s = sessionFor(llm);
    await s.start();
    const turn = await s.handleUserUtterance(user);
    expect(llm.seen.at(-1)!.at(-1)).toEqual({ role: "user", content: user });
    expect(turn.spokenText).toBe(reply);
    expect(turn.chunks!.join(" ")).toBe(reply);
    expect(turn.chunks!.length).toBe(2); // two sentences in every language
  });
});

describe("concurrent streams", () => {
  it("many simultaneous sessions keep their own replies, chunks and history", async () => {
    const N = 12;
    const runs = Array.from({ length: N }, (_, i) => {
      const llm = new ScriptedStreamingLlm([{ deltas: ["Hi."] }, { deltas: [`Reply ${i} first. `, `Reply ${i} second.`] }]);
      const s = sessionFor(llm);
      return s.start().then(() => s.handleUserUtterance(`question ${i}`).then((t) => ({ i, t, s })));
    });
    const results = await Promise.all(runs);
    for (const { i, t, s } of results) {
      expect(t.chunks).toEqual([`Reply ${i} first.`, `Reply ${i} second.`]);
      expect(msgs(s).filter((m) => m.role === "user").map((m) => m.content)).toEqual([expect.stringContaining("Call connected"), `question ${i}`]);
    }
  });
});
