/**
 * Agents are generic Voice AI agents: everything Sales-specific about them (the real-estate template, its tools, its
 * settings block, project knowledge) comes from the Sales module's registrations, not from the core agents code.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { RequestContext } from "../../auth/context.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";
import { agentsService } from "./agents.service.js";
import { createAgentSchema, replaceKnowledgeSchema, updateAgentSchema } from "./agents.validation.js";
import { defaultToolsFor } from "./agents.constants.js";
import { mergeModuleConfig, normalizeModuleConfig } from "./agent-extensions.js";
import { SALES_TOOLS } from "../sales/tools/index.js";
import { SALES_TOOL_NAMES } from "../sales/sales-constants.js";
import { registerSalesModule } from "../sales/index.js";
import { unregisterModule } from "../modules/module-runtime.js";

let A: TestTenant; // Sales on
let B: TestTenant; // Sales off
let ctxA: RequestContext;
let ctxB: RequestContext;

beforeAll(async () => {
  A = await createTenant("AG_A");
  B = await createTenant("AG_B", { modules: [] });
  // User contexts: module gating applies to users, not to system flows.
  ctxA = { organizationId: A.orgId, actor: { type: "user", userId: A.userId, role: "OWNER" } };
  ctxB = { organizationId: B.orgId, actor: { type: "user", userId: B.userId, role: "OWNER" } };
});

afterEach(() => registerSalesModule());

afterAll(async () => {
  await cleanupTenants();
});

describe("Sales constants", () => {
  it("SALES_TOOL_NAMES is exactly the Sales module's tools plus end_call, in the historical order", () => {
    expect(SALES_TOOL_NAMES).toEqual([...SALES_TOOLS.map((t) => t.definition.name), "end_call"]);
  });
});

describe("with the Sales module registered", () => {
  it("a new real-estate agent starts from the Sales default tools", () => {
    expect(defaultToolsFor("sales_real_estate")).toEqual([...SALES_TOOL_NAMES]);
    expect(defaultToolsFor("generic")).toEqual(["end_call"]);
  });

  it("the Sales settings block is validated by the Sales module's own schema", () => {
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", moduleConfig: { sales: { offerSlots: 2 } } }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", moduleConfig: { sales: { offerSlots: 9 } } }).success).toBe(false);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", moduleConfig: { sales: { bogus: 1 } } }).success).toBe(false);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", moduleConfig: { nobody: {} } }).success).toBe(false);
  });

  it("settings merge over defaults and over what is stored, keeping unrelated stored keys", () => {
    expect(mergeModuleConfig({}, { sales: { autoBook: false } })).toEqual({ sales: { offerSlots: 3, autoBook: false } });
    expect(mergeModuleConfig({ sales: { offerSlots: 1, autoBook: true }, other: { a: 1 } }, { sales: { autoBook: false } })).toEqual({
      sales: { offerSlots: 1, autoBook: false },
      other: { a: 1 },
    });
    expect(normalizeModuleConfig({ sales: { offerSlots: 99 }, other: { a: 1 } })).toEqual({ sales: { offerSlots: 3, autoBook: true } });
  });

  it("knowledge is bound through the registered source type, project must exist in the org", async () => {
    const agent = await agentsService.create(ctxA, { name: "AG knowledge", personaName: "K", promptTemplateKey: "generic" });
    const bound = await agentsService.replaceKnowledge(ctxA, agent.id, { bindings: [{ sourceType: "project", sourceId: A.projectId }] });
    expect(bound.knowledge).toEqual([{ sourceType: "project", sourceId: A.projectId }]);
    await expect(
      agentsService.replaceKnowledge(ctxA, agent.id, { bindings: [{ sourceType: "project", sourceId: B.projectId }] }),
    ).rejects.toThrow(/not found/i);
    expect((await agentsService.replaceKnowledge(ctxA, agent.id, { bindings: [] })).knowledge).toEqual([]);
  });

  it("Sales disabled for the org: the real-estate template and project knowledge are refused, generic agents work", async () => {
    await expect(agentsService.create(ctxB, { name: "AG sales off", personaName: "S", promptTemplateKey: "sales_real_estate" })).rejects.toThrow(/not enabled/i);
    const generic = await agentsService.create(ctxB, { name: "AG generic off", personaName: "G" });
    expect(generic.enabledTools).toEqual(["end_call"]);
    expect(generic.moduleConfig).toEqual({});
    await expect(
      agentsService.replaceKnowledge(ctxB, generic.id, { bindings: [{ sourceType: "project", sourceId: A.projectId }] }),
    ).rejects.toThrow(/not enabled/i);
    expect((await agentsService.replaceKnowledge(ctxB, generic.id, { bindings: [] })).knowledge).toEqual([]);
  });
});

describe("with the Sales module NOT registered", () => {
  it("the core knows no real-estate template, no module settings and no knowledge source types", () => {
    unregisterModule("sales");
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y" }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", promptTemplateKey: "generic" }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", promptTemplateKey: "sales_real_estate" }).success).toBe(false);
    expect(createAgentSchema.safeParse({ name: "x", personaName: "y", moduleConfig: { sales: {} } }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ enabledTools: ["get_project_price"] }).success).toBe(false);
    expect(replaceKnowledgeSchema.safeParse({ bindings: [{ sourceType: "project", sourceId: A.projectId }] }).success).toBe(false);
    expect(replaceKnowledgeSchema.safeParse({ bindings: [] }).success).toBe(true);
    expect(defaultToolsFor("sales_real_estate")).toEqual(["end_call"]);
  });

  it("a stored Sales settings block is hidden, not destroyed", () => {
    unregisterModule("sales");
    const stored = { sales: { offerSlots: 2, autoBook: false } };
    expect(normalizeModuleConfig(stored)).toEqual({});
    expect(mergeModuleConfig(stored, {})).toEqual(stored);
  });

  it("a generic agent can be created, edited and listed", async () => {
    unregisterModule("sales");
    const agent = await agentsService.create(ctxB, { name: "AG core only", personaName: "C" });
    const updated = await agentsService.update(ctxB, agent.id, { tone: "friendly", behaviour: { maxResponseSentences: 2 } });
    expect(updated.tone).toBe("friendly");
    expect(updated.enabledTools).toEqual(["end_call"]);
  });
});
