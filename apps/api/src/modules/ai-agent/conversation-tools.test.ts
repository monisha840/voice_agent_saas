/**
 * The LLM -> tool call -> tool result -> LLM contract, with a scripted model and real (test) tools: sequential
 * multi-step conversations, tool-call id preservation and pairing, failures that never run a tool twice, timeouts,
 * garbled arguments, cancellation, and a history that stays valid throughout. Real Postgres for the transcript.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";

import { ConversationSession, ConversationCancelledError } from "./conversation.js";
import { registerTool, unregisterTool } from "../../ai-tools/index.js";
import type { AiTool, ToolExecutionContext } from "../../ai-tools/types.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolCallRequest, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { callsService } from "../calls/calls.service.js";
import { defaultAgentIdFor } from "../../test/tenants.js";
import { demoContext } from "../../test/helpers.js";
import type { RequestContext } from "../../auth/context.js";

/** A model that replays a script and records exactly what it was sent on every call (a snapshot, not a live reference). */
class ScriptedLlm implements ILanguageModel {
  readonly name = "scripted";
  readonly seen: ChatMessage[][] = [];
  private i = 0;
  private readonly script: Array<ChatResult | ((messages: ChatMessage[]) => ChatResult)>;
  /** `script` is what the model does AFTER the opening line (session.start() always consumes the first step). */
  constructor(script: Array<ChatResult | ((messages: ChatMessage[]) => ChatResult)>) {
    this.script = [{ content: "Hello, this is the test agent." }, ...script];
  }
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.seen.push(structuredClone(messages));
    const step = this.script[Math.min(this.i++, this.script.length - 1)];
    return typeof step === "function" ? step(messages) : step;
  }
  get calls() {
    return this.seen.length;
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}, extra: Partial<ToolCallRequest> = {}): ToolCallRequest => ({ id, name, arguments: args, ...extra });

/** The invariant a real OpenAI-style endpoint enforces: every tool message answers a call declared EARLIER, once. */
function assertValidToolHistory(messages: ChatMessage[]) {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) {
      expect(declared.has(c.id), `tool call id ${c.id} declared twice`).toBe(false);
      declared.add(c.id);
    }
    if (m.role === "tool") {
      expect(declared.has(m.toolCallId ?? ""), `tool result ${m.toolCallId} answers no declared call`).toBe(true);
      expect(answered.has(m.toolCallId!), `tool call ${m.toolCallId} answered twice`).toBe(false);
      answered.add(m.toolCallId!);
    }
  }
  // Nothing declared is left unanswered (a half-finished batch would be rejected by a real endpoint).
  for (const id of declared) expect(answered.has(id), `tool call ${id} was never answered`).toBe(true);
}

const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
const makeTool = (name: string, run: (args: Record<string, unknown>) => Promise<unknown> | unknown): AiTool => ({
  definition: { name, description: `test tool ${name}`, parameters: { type: "object", properties: {} } } satisfies ToolDefinition,
  async execute(args) {
    executed.push({ name, args });
    return run(args);
  },
});
const TOOLS = ["zz_lookup", "zz_reserve", "zz_flaky", "zz_slow"];

let org: RequestContext;
let ctx: ToolExecutionContext;
const sessionFor = (llm: ILanguageModel) => new ConversationSession(llm, ctx, {});

beforeAll(async () => {
  org = await demoContext();
  const call = await callsService.createCall(org, { agentId: await defaultAgentIdFor(org.organizationId), callType: "test" });
  ctx = { organizationId: org.organizationId, callId: call.id };
  registerTool(makeTool("zz_lookup", (a) => ({ found: true, item: a.item ?? null })));
  registerTool(makeTool("zz_reserve", (a) => ({ reserved: true, item: a.item ?? null })));
  registerTool(
    makeTool("zz_flaky", () => {
      throw new Error("database connection lost");
    }),
  );
  registerTool(makeTool("zz_slow", async () => new Promise((r) => setTimeout(() => r({ done: true }), 300))));
});
afterAll(() => {
  for (const t of TOOLS) unregisterTool(t);
});
afterEach(() => {
  executed.length = 0;
  delete process.env.TOOL_TIMEOUT_MS;
  vi.restoreAllMocks();
});

describe("sequential multi-step tool calls", () => {
  it("two dependent tool calls in consecutive hops: each runs once, in order, and each result reaches the model paired with its call id", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("call_A", "zz_lookup", { item: "2 BHK" })] },
      (messages) => {
        // the model sees the first result before deciding on the second call
        const first = messages.filter((m) => m.role === "tool").at(-1)!;
        expect(first.toolCallId).toBe("call_A");
        expect(JSON.parse(first.content)).toEqual({ found: true, item: "2 BHK" });
        return { toolCalls: [call("call_B", "zz_reserve", { item: "2 BHK" })] };
      },
      { content: "Your 2 BHK is reserved." },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    const turn = await session.handleUserUtterance("Please reserve a 2 BHK");

    expect(turn).toEqual({ spokenText: "Your 2 BHK is reserved.", shouldEndCall: false });
    expect(executed).toEqual([
      { name: "zz_lookup", args: { item: "2 BHK" } },
      { name: "zz_reserve", args: { item: "2 BHK" } },
    ]);
    expect(llm.calls).toBe(3);

    // Hop 2 saw: user, assistant{call_A + its ARGUMENTS}, tool{call_A}.
    const hop2 = llm.seen[1].slice(-3);
    expect(hop2[0].role).toBe("user");
    expect(hop2[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call_A", name: "zz_lookup", arguments: { item: "2 BHK" } }] });
    expect(hop2[2]).toMatchObject({ role: "tool", toolCallId: "call_A" });
    // Hop 3 saw both pairs, in order, each result attached to its own id.
    const hop3 = llm.seen[2].slice(-5);
    expect(hop3.map((m) => [m.role, m.toolCallId ?? m.toolCalls?.[0]?.id])).toEqual([
      ["user", undefined],
      ["assistant", "call_A"],
      ["tool", "call_A"],
      ["assistant", "call_B"],
      ["tool", "call_B"],
    ]);
    expect(JSON.parse(hop3[2].content)).toMatchObject({ found: true });
    expect(JSON.parse(hop3[4].content)).toMatchObject({ reserved: true });
    assertValidToolHistory(llm.seen[2]);
  });

  it("several tool calls in ONE response are one assistant message, answered in order by one tool message each", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("p1", "zz_lookup", { item: "a" }), call("p2", "zz_reserve", { item: "b" })] },
      { content: "Done." },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    await session.handleUserUtterance("do both");
    expect(executed.map((e) => e.name)).toEqual(["zz_lookup", "zz_reserve"]);
    const last = llm.seen.at(-1)!;
    const assistant = last.filter((m) => m.role === "assistant" && m.toolCalls);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].toolCalls!.map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(last.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["p1", "p2"]);
    assertValidToolHistory(last);
  });
});

describe("tool failure", () => {
  it("a tool that throws is run exactly once; the model gets a structured error and the conversation stays valid and usable", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("f1", "zz_flaky")] },
      { content: "Sorry, I could not check that." },
      { content: "Anything else?" },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;

    const first = await session.handleUserUtterance("check it");
    expect(first.spokenText).toBe("Sorry, I could not check that.");
    expect(executed.filter((e) => e.name === "zz_flaky")).toHaveLength(1); // not retried, not run twice
    const errorMsg = llm.seen[1].filter((m) => m.role === "tool").at(-1)!;
    expect(errorMsg.toolCallId).toBe("f1");
    expect(JSON.parse(errorMsg.content)).toHaveProperty("error");
    assertValidToolHistory(llm.seen[1]);

    // The next customer turn proceeds on that same history.
    const second = await session.handleUserUtterance("ok thanks");
    expect(second.spokenText).toBe("Anything else?");
    assertValidToolHistory(llm.seen.at(-1)!);
    expect(executed.filter((e) => e.name === "zz_flaky")).toHaveLength(1);
  });

  it("an unknown or disallowed tool name is answered with an error and not executed", async () => {
    const llm = new ScriptedLlm([{ toolCalls: [call("u1", "does_not_exist")] }, { content: "ok" }]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    await session.handleUserUtterance("x");
    expect(JSON.parse(llm.seen[1].filter((m) => m.role === "tool").at(-1)!.content).error).toMatch(/Unknown tool/);
    assertValidToolHistory(llm.seen[1]);
  });

  it("a tool that outlives the timeout is reported as outcome-unknown (do not repeat it) and is never started twice", async () => {
    process.env.TOOL_TIMEOUT_MS = "40";
    const llm = new ScriptedLlm([{ toolCalls: [call("s1", "zz_slow")] }, { content: "It is taking a while." }]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    const turn = await session.handleUserUtterance("go");
    expect(turn.spokenText).toBe("It is taking a while.");
    const result = JSON.parse(llm.seen[1].filter((m) => m.role === "tool").at(-1)!.content);
    expect(result.error).toMatch(/outcome is unknown/i);
    expect(executed.filter((e) => e.name === "zz_slow")).toHaveLength(1);
    assertValidToolHistory(llm.seen[1]);
  });

  it("arguments the model garbled are NOT run on guessed values: the model is told, and can retry properly", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("g1", "zz_reserve", {}, { invalidArguments: true })] },
      { toolCalls: [call("g2", "zz_reserve", { item: "3 BHK" })] },
      { content: "Reserved the 3 BHK." },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    const turn = await session.handleUserUtterance("reserve");
    expect(turn.spokenText).toBe("Reserved the 3 BHK.");
    expect(executed).toEqual([{ name: "zz_reserve", args: { item: "3 BHK" } }]); // only the valid call ran
    expect(JSON.parse(llm.seen[1].filter((m) => m.role === "tool").at(-1)!.content).error).toMatch(/not valid/);
    assertValidToolHistory(llm.seen[2]);
  });
});

describe("tool-call ids", () => {
  it("an empty id gets a unique one, used identically on the assistant call and its result", async () => {
    const llm = new ScriptedLlm([{ toolCalls: [call("", "zz_lookup", { item: "x" })] }, { content: "ok" }]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    await session.handleUserUtterance("x");
    const history = llm.seen[1];
    const declared = history.flatMap((m) => m.toolCalls ?? []).at(-1)!;
    expect(declared.id).toMatch(/^call_\d+$/);
    expect(history.filter((m) => m.role === "tool").at(-1)!.toolCallId).toBe(declared.id);
    assertValidToolHistory(history);
  });

  it("a provider that reuses ids across turns (index-based 'call_0') still yields unique, correctly paired ids", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("call_0", "zz_lookup", { item: "first" })] },
      { content: "one" },
      { toolCalls: [call("call_0", "zz_lookup", { item: "second" })] },
      { content: "two" },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    await session.handleUserUtterance("first");
    await session.handleUserUtterance("second");
    expect(executed.map((e) => e.args.item)).toEqual(["first", "second"]); // the second call was NOT mistaken for a repeat
    const history = llm.seen.at(-1)!;
    const ids = history.flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    assertValidToolHistory(history);
  });

  it("an exact repeat of the same call (same id, tool, arguments) inside one response runs once", async () => {
    const llm = new ScriptedLlm([
      { toolCalls: [call("d1", "zz_reserve", { item: "x" }), call("d1", "zz_reserve", { item: "x" })] },
      { content: "ok" },
    ]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    await session.handleUserUtterance("x");
    expect(executed).toHaveLength(1);
    expect(llm.seen[1].filter((m) => m.role === "tool")).toHaveLength(1);
    assertValidToolHistory(llm.seen[1]);
  });
});

describe("cancellation", () => {
  it("a call that has already ended starts no model request and runs no tool", async () => {
    const llm = new ScriptedLlm([{ toolCalls: [call("c1", "zz_reserve")] }]);
    const session = sessionFor(llm);
    const controller = new AbortController();
    controller.abort();
    executed.length = 0;
    await expect(session.handleUserUtterance("hello", { signal: controller.signal })).rejects.toBeInstanceOf(ConversationCancelledError);
    expect(llm.calls).toBe(0);
    expect(executed).toHaveLength(0);
  });

  it("if the call ends part-way through a batch, the remaining tools are not run, but every call is still answered", async () => {
    const controller = new AbortController();
    const llm = new ScriptedLlm([{ toolCalls: [call("k1", "zz_lookup", { item: "a" }), call("k2", "zz_reserve", { item: "b" })] }, { content: "never" }]);
    const session = sessionFor(llm);
    await session.start();
    llm.seen.length = 0;
    executed.length = 0;
    // The first tool finishes and, as it does, the call ends.
    unregisterTool("zz_lookup");
    registerTool(
      makeTool("zz_lookup", (a) => {
        controller.abort();
        return { found: true, item: a.item };
      }),
    );
    await expect(session.handleUserUtterance("both", { signal: controller.signal })).rejects.toBeInstanceOf(ConversationCancelledError);
    expect(executed.map((e) => e.name)).toEqual(["zz_lookup"]); // zz_reserve never ran
    expect(llm.calls).toBe(1); // no further model request
    // The session's history is still valid (both calls answered), so nothing is left dangling.
    const internal = (session as unknown as { messages: ChatMessage[] }).messages;
    assertValidToolHistory(internal);
    expect(JSON.parse(internal.filter((m) => m.role === "tool").at(-1)!.content).error).toMatch(/Not run/);

    unregisterTool("zz_lookup");
    registerTool(makeTool("zz_lookup", (a) => ({ found: true, item: a.item ?? null })));
  });

  it("the abort signal is handed to the model request so it can stop", async () => {
    let received: AbortSignal | undefined;
    const llm: ILanguageModel = {
      name: "spy",
      async chat(_m, _t, opts) {
        received = opts?.signal;
        return { content: "hi" };
      },
    };
    const controller = new AbortController();
    await sessionFor(llm).start({ signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});
