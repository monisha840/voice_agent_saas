/**
 * The Sales module as the core sees it: what a live call keeps and loses when the module is switched off, and that
 * the real-estate agent's "no restriction" prompt value can never widen the tools a session actually offers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { organizationModules } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { executeTool } from "../../ai-tools/index.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { callRuntime } from "../calls/call-runtime.js";
import { ConversationSession } from "../ai-agent/conversation.js";
import type { ChatMessage, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";

let A: TestTenant;
let ctxA: ReturnType<typeof systemContext>;

const setSales = (enabled: boolean) =>
  db
    .update(organizationModules)
    .set({ enabled })
    .where(and(eq(organizationModules.organizationId, A.orgId), eq(organizationModules.moduleKey, "sales")));

beforeAll(async () => {
  A = await createTenant("SM_A");
  ctxA = systemContext(A.orgId, "test");
});

afterAll(async () => {
  await cleanupTenants();
});

describe("switching Sales off while a call is in progress", () => {
  it("the running call keeps its tools; a NEW call on the same lead gets only end_call", async () => {
    const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "outbound", agentId: A.agentId, leadId: A.leadId });
    const running = await callRuntime.build(ctxA, call);
    expect(running.effectiveTools).toContain("check_visit_slots");

    await setSales(false);
    try {
      // The live session holds the allow-list it was built with; nothing re-checks the module mid-call.
      const slots = (await executeTool("check_visit_slots", {}, running.toolContext, running.effectiveTools)) as { slots?: unknown[] };
      expect(Array.isArray(slots.slots)).toBe(true);

      const fresh = await callRuntime.build(ctxA, await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "outbound", agentId: A.agentId, leadId: A.leadId }));
      expect(fresh.effectiveTools).toEqual(["end_call"]);
    } finally {
      await setSales(true);
    }
  });
});

describe("the session's tool list is always explicit", () => {
  function spy() {
    const seen: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }> = [];
    const llm: ILanguageModel = {
      name: "spy",
      async chat(messages, tools) {
        seen.push({ messages: messages.map((m) => ({ ...m })), tools });
        return { content: "ok" };
      },
    };
    return { llm, seen };
  }

  it("a real-estate agent with every tool still offers exactly those tools, via effectiveTools (its prompt value is the legacy empty list)", async () => {
    const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "outbound", agentId: A.agentId, leadId: A.leadId });
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.config.allowedTools).toEqual([]); // keeps the legacy prompt byte-identical
    expect(rt.config.effectiveTools).toEqual(rt.effectiveTools);
    const { llm, seen } = spy();
    await new ConversationSession(llm, rt.toolContext, rt.promptParams, rt.config).start();
    expect(seen[0].tools.map((t) => t.name).sort()).toEqual([...rt.effectiveTools].sort());
  });

  it("an agent config whose effectiveTools is empty offers only end_call, even with a legacy empty allowedTools", async () => {
    const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "test", agentId: A.agentId });
    const rt = await callRuntime.build(ctxA, call);
    const { llm, seen } = spy();
    await new ConversationSession(llm, rt.toolContext, rt.promptParams, { ...rt.config, allowedTools: [], effectiveTools: [] }).start();
    expect(seen[0].tools.map((t) => t.name)).toEqual(["end_call"]);
  });
});
