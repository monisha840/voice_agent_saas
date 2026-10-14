/**
 * callRuntime.build: turns a stored call into the live conversation setup (agent config, prompt parameters, effective
 * tools, tool context, language), through the real Sales hooks and the real database. No telephony, no HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { agentKnowledgeBindings, leads, organizationModules, projects } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { ALL_TOOL_NAMES } from "../../ai-tools/index.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { buildSystemPrompt } from "../ai-agent/persona.js";
import { agentsService } from "../agents/agents.service.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../test/tenants.js";
import { callRuntime } from "./call-runtime.js";

let A: TestTenant; // sales on
let B: TestTenant; // sales on (a different organization)
let C: TestTenant; // sales off
let ctxA: ReturnType<typeof systemContext>;
let ctxB: ReturnType<typeof systemContext>;
let ctxC: ReturnType<typeof systemContext>;

type CallInput = Partial<Parameters<typeof callsRepository.create>[0]> & { agentId: string };

async function makeCall(orgId: string, input: CallInput) {
  return callsRepository.create({ organizationId: orgId, status: "in_progress", callType: "outbound", ...input });
}

const generic = (orgId: string, name: string, overrides: Partial<Parameters<typeof createDefaultAgent>[1]> = {}) =>
  createDefaultAgent(orgId, {
    name,
    personaName: name,
    promptTemplateKey: "generic",
    enabledTools: ["end_call"],
    isDefault: false,
    moduleConfig: {},
    ...overrides,
  });

const SALES_ONLY = ALL_TOOL_NAMES.filter((t) => t !== "end_call");

beforeAll(async () => {
  A = await createTenant("CR_A");
  B = await createTenant("CR_B");
  C = await createTenant("CR_C", { modules: [] });
  ctxA = systemContext(A.orgId, "test");
  ctxB = systemContext(B.orgId, "test");
  ctxC = systemContext(C.orgId, "test");
});

afterAll(async () => {
  await cleanupTenants();
});

describe("tool filtering", () => {
  it("a sales agent on a lead call (with project) exposes all 9 tools and keeps the legacy prompt byte for byte", async () => {
    const call = await makeCall(A.orgId, { agentId: A.agentId, leadId: A.leadId });
    const rt = await callRuntime.build(ctxA, call);

    expect([...rt.effectiveTools].sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(rt.effectiveTools).toHaveLength(11);
    expect(rt.config.allowedTools).toEqual([]); // the legacy "no restriction" value
    expect(rt.config.promptTemplateKey).toBe("sales_real_estate");

    const legacyPrompt = buildSystemPrompt({ leadName: "CR_A Lead", projectName: "CR_A Heights" }, rt.config);
    const runtimePrompt = buildSystemPrompt(rt.promptParams, rt.config);
    // The only additions to the legacy text are facts about this call: the current time (the CRM holds no requirement
    // or budget for this lead, so nothing else is added).
    expect(rt.promptParams.currentTime).toBeTruthy();
    expect(runtimePrompt.replace(/\nIt is now [^\n]*\./, "")).toBe(legacyPrompt);
    expect(runtimePrompt).not.toContain("Only these tools are enabled");
    expect(runtimePrompt).toContain("CR_A Lead");
    expect(runtimePrompt).toContain("CR_A Heights");

    expect(rt.toolContext).toEqual({
      organizationId: A.orgId,
      callId: call.id,
      agentId: A.agentId,
      callType: "outbound",
      subject: { leadId: A.leadId, projectId: A.projectId },
    });
  });

  it("a sales agent on a leadless call with no knowledge binding exposes only the core tools", async () => {
    const call = await makeCall(A.orgId, { agentId: A.agentId, callType: "test" });
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.effectiveTools).toEqual(["end_call"]);
    expect(rt.config.allowedTools).toEqual(["end_call"]); // restricted, so the prompt names the enabled tools
    expect(rt.toolContext.subject).toBeUndefined();
    expect(buildSystemPrompt(rt.promptParams, rt.config)).toContain("Only these tools are enabled for this call: end_call");
  });

  it("with the Sales module disabled even a lead call hides every sales tool", async () => {
    const [lead] = await db.select().from(leads).where(eq(leads.id, C.leadId));
    expect(lead).toBeTruthy();
    const call = await makeCall(C.orgId, { agentId: C.agentId, leadId: C.leadId });
    const rt = await callRuntime.build(ctxC, call);
    expect(rt.effectiveTools).toEqual(["end_call"]);
    for (const t of SALES_ONLY) expect(rt.effectiveTools).not.toContain(t);
  });

  it("disabling the module for an organization takes effect on the next build and re-enabling restores the tools", async () => {
    const call = await makeCall(A.orgId, { agentId: A.agentId, leadId: A.leadId });
    expect((await callRuntime.build(ctxA, call)).effectiveTools).toHaveLength(11);
    await db.update(organizationModules).set({ enabled: false }).where(and(eq(organizationModules.organizationId, A.orgId), eq(organizationModules.moduleKey, "sales")));
    try {
      expect((await callRuntime.build(ctxA, call)).effectiveTools).toEqual(["end_call"]);
    } finally {
      await db.update(organizationModules).set({ enabled: true }).where(and(eq(organizationModules.organizationId, A.orgId), eq(organizationModules.moduleKey, "sales")));
    }
    expect((await callRuntime.build(ctxA, call)).effectiveTools).toHaveLength(11);
  });

  it("a generic agent with tools [end_call] never exposes sales tools, even on a lead call", async () => {
    const agent = await generic(A.orgId, "CR generic tools");
    const call = await makeCall(A.orgId, { agentId: agent.id, leadId: A.leadId });
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.effectiveTools).toEqual(["end_call"]);
    expect(rt.config.promptTemplateKey).toBe("generic");
    const prompt = buildSystemPrompt(rt.promptParams, rt.config);
    expect(prompt).not.toMatch(/real-estate|site visit|book_site_visit/i);
  });

  it("two agents in one organization get different prompts, personas and tool sets for the same lead", async () => {
    const other = await generic(A.orgId, "Zed", { enabledTools: ["update_lead", "end_call"], personaName: "Zed", tone: "formal" });
    const callX = await makeCall(A.orgId, { agentId: A.agentId, leadId: A.leadId });
    const callY = await makeCall(A.orgId, { agentId: other.id, leadId: A.leadId });
    const x = await callRuntime.build(ctxA, callX);
    const y = await callRuntime.build(ctxA, callY);

    expect(x.config.agentName).toBe("Priya");
    expect(y.config.agentName).toBe("Zed");
    expect(x.effectiveTools).toHaveLength(11);
    expect(y.effectiveTools).toEqual(["update_lead", "end_call"]);
    const px = buildSystemPrompt(x.promptParams, x.config);
    const py = buildSystemPrompt(y.promptParams, y.config);
    expect(px).not.toBe(py);
    expect(px).toContain("Priya");
    expect(px).not.toContain("Zed");
    expect(py).toContain("Zed");
    expect(py).not.toContain("Priya");
    expect(x.toolContext.subject?.leadId).toBe(A.leadId);
    expect(y.toolContext.subject?.leadId).toBe(A.leadId);
    expect(x.toolContext.agentId).not.toBe(y.toolContext.agentId);
  });
});

describe("agent-specific prompts and language", () => {
  it("persona, greeting, language and system prompt appear for the right agent only", async () => {
    const g1 = await generic(A.orgId, "CR Aarav", {
      personaName: "Aarav",
      greeting: "Namaste from the Aarav desk",
      language: "hi-IN",
      systemPrompt: "ROLE-ONE: you handle billing questions.",
      companyName: "Acme One",
    });
    const g2 = await generic(A.orgId, "CR Bela", {
      personaName: "Bela",
      greeting: "Hello from the Bela desk",
      language: "en-IN",
      systemPrompt: "ROLE-TWO: you handle shipping questions.",
      companyName: "Beta Two",
    });
    const r1 = await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: g1.id, callType: "test" }));
    const r2 = await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: g2.id, callType: "test" }));
    const p1 = buildSystemPrompt(r1.promptParams, r1.config);
    const p2 = buildSystemPrompt(r2.promptParams, r2.config);

    for (const needle of ["Aarav", "Namaste from the Aarav desk", "Hindi", "ROLE-ONE", "Acme One"]) {
      expect(p1).toContain(needle);
      expect(p2).not.toContain(needle);
    }
    for (const needle of ["Bela", "Hello from the Bela desk", "ROLE-TWO", "Beta Two"]) {
      expect(p2).toContain(needle);
      expect(p1).not.toContain(needle);
    }
    expect(p2).toContain("Speak in English");
    expect(r1.config).toMatchObject({ agentName: "Aarav", greeting: "Namaste from the Aarav desk", language: "hi-IN", systemPrompt: "ROLE-ONE: you handle billing questions." });
    expect(r2.config.agentName).toBe("Bela");
  });

  it("languageCode: en-IN is undefined (provider auto-detect), hi-IN is passed through", async () => {
    const en = await generic(A.orgId, "CR english", { language: "en-IN" });
    const hi = await generic(A.orgId, "CR hindi", { language: "hi-IN" });
    const ta = await generic(A.orgId, "CR tamil", { language: "ta-IN" });
    expect((await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: en.id, callType: "test" }))).languageCode).toBeUndefined();
    expect((await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: hi.id, callType: "test" }))).languageCode).toBe("hi-IN");
    expect((await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: ta.id, callType: "test" }))).languageCode).toBe("ta-IN");
  });
});

describe("tool context and prompt parameters", () => {
  it("carries agentId and callType, and omits leadId/projectId when the call has neither", async () => {
    const agent = await generic(A.orgId, "CR context");
    for (const callType of ["test", "inbound", "outbound"] as const) {
      const call = await makeCall(A.orgId, { agentId: agent.id, callType, counterpartyName: "Dana" });
      const rt = await callRuntime.build(ctxA, call);
      expect(rt.toolContext).toEqual({ organizationId: A.orgId, callId: call.id, agentId: agent.id, callType });
      expect(rt.promptParams).toMatchObject({ callType, direction: callType === "inbound" ? "inbound" : "outbound", contactName: "Dana" });
    }
  });

  it("an inbound call from a known lead describes the lead as the contact", async () => {
    const agent = await generic(A.orgId, "CR inbound lead");
    const call = await makeCall(A.orgId, { agentId: agent.id, callType: "inbound", leadId: A.leadId });
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.promptParams.contactName).toBe("CR_A Lead");
    expect(rt.toolContext.subject?.leadId).toBe(A.leadId);
    expect(buildSystemPrompt(rt.promptParams, rt.config)).toContain("CR_A Lead has called you");
  });

  it("an unknown contact has a null contact name", async () => {
    const agent = await generic(A.orgId, "CR unknown");
    const rt = await callRuntime.build(ctxA, await makeCall(A.orgId, { agentId: agent.id, callType: "inbound" }));
    expect(rt.promptParams.contactName).toBeNull();
  });
});

describe("agent lifecycle and tenancy", () => {
  it("an archived agent still works for an already-created call", async () => {
    const agent = await generic(A.orgId, "CR soon archived", { personaName: "Archie" });
    const call = await makeCall(A.orgId, { agentId: agent.id, callType: "test" });
    await agentsService.archive(ctxA, agent.id);
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.agent.id).toBe(agent.id);
    expect(rt.agent.status).toBe("archived");
    expect(rt.config.agentName).toBe("Archie");
  });

  it("a call cannot be run with another organization's context", async () => {
    const call = await makeCall(A.orgId, { agentId: A.agentId, callType: "test" });
    await expect(callRuntime.build(ctxB, call)).rejects.toThrow(/not found/i);
  });
});

describe("a lead-less agent bound to a project", () => {
  let boundAgentId = "";
  let projectId = "";
  let cAgentId = "";

  beforeAll(async () => {
    const [p] = await db.insert(projects).values({ organizationId: A.orgId, name: "CR Bound Project", location: "Elsewhere" }).returning();
    projectId = p.id;
    const agent = await createDefaultAgent(A.orgId, { name: "CR bound sales", isDefault: false });
    boundAgentId = agent.id;
    await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId: agent.id, sourceType: "project", sourceId: p.id });

    const [pc] = await db.insert(projects).values({ organizationId: C.orgId, name: "CR C Project", location: "x" }).returning();
    const agentC = await createDefaultAgent(C.orgId, { name: "CR C bound", isDefault: false });
    cAgentId = agentC.id;
    await db.insert(agentKnowledgeBindings).values({ organizationId: C.orgId, agentId: agentC.id, sourceType: "project", sourceId: pc.id });
  });

  it("gets the project's knowledge (projectId set, leadId unset) while Sales is enabled", async () => {
    const call = await makeCall(A.orgId, { agentId: boundAgentId, callType: "test" });
    const rt = await callRuntime.build(ctxA, call);
    expect(rt.toolContext.subject?.projectId).toBe(projectId);
    expect(rt.toolContext.subject?.leadId).toBeUndefined();
    expect(rt.promptParams.projectName).toBe("CR Bound Project");
    // project-only tools (and the follow-up note for the team) are offered; lead tools are not
    expect([...rt.effectiveTools].sort()).toEqual(
      ["end_call", "get_project_configurations", "get_project_details", "get_project_location", "get_nearby_places", "get_project_price", "request_follow_up"].sort(),
    );
    for (const t of ["update_lead", "mark_not_interested", "check_visit_slots", "book_site_visit"]) expect(rt.effectiveTools).not.toContain(t);
  });

  it("gets nothing when the Sales module is disabled", async () => {
    const call = await makeCall(C.orgId, { agentId: cAgentId, callType: "test" });
    const rt = await callRuntime.build(ctxC, call);
    expect(rt.toolContext.subject?.projectId).toBeUndefined();
    expect(rt.toolContext.subject?.leadId).toBeUndefined();
    expect(rt.promptParams.projectName).toBeUndefined();
    expect(rt.effectiveTools).toEqual(["end_call"]);
  });

  it("an agent bound to a project of another organization's data cannot leak it: org B's agent has no knowledge of A's project", async () => {
    const call = await makeCall(B.orgId, { agentId: B.agentId, callType: "test" });
    const rt = await callRuntime.build(ctxB, call);
    expect(rt.toolContext.subject?.projectId).toBeUndefined();
    expect(JSON.stringify(rt)).not.toContain(projectId);
  });
});
