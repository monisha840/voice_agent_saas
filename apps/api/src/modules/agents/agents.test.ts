import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { agentKnowledgeBindings, agents, auditLogs, calls } from "../../db/schema.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { systemContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { agentsService } from "./agents.service.js";
import { SALES_TOOL_NAMES } from "../sales/sales-constants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant; // sales on
let B: TestTenant; // sales on, a different organization
let C: TestTenant; // sales off
let owner: string;
let admin: string;
let manager: string;
let agentRole: string;
let ownerB: string;
let ownerC: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = { data?: any; error?: string };

async function http(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const orgIds = () => [A.orgId, B.orgId, C.orgId];

beforeAll(async () => {
  A = await createTenant("AgA");
  B = await createTenant("AgB");
  C = await createTenant("AgC", { modules: [] });
  const adminM = await createMember(A.orgId, "ADMIN");
  const managerM = await createMember(A.orgId, "MANAGER");
  const agentM = await createMember(A.orgId, "AGENT");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  owner = await loginCookie(baseUrl, A.email);
  ownerB = await loginCookie(baseUrl, B.email);
  ownerC = await loginCookie(baseUrl, C.email);
  admin = await loginCookie(baseUrl, adminM.email);
  manager = await loginCookie(baseUrl, managerM.email);
  agentRole = await loginCookie(baseUrl, agentM.email);
});

afterAll(async () => {
  await app.close();
  // Agents restrict organization deletion and cleanupTenants does not know them.
  await db.delete(calls).where(inArray(calls.organizationId, orgIds())); // calls restrict-reference their agent
  await db.delete(agentKnowledgeBindings).where(inArray(agentKnowledgeBindings.organizationId, orgIds()));
  await db.delete(agents).where(inArray(agents.organizationId, orgIds()));
  for (const id of orgIds()) await db.delete(auditLogs).where(eq(auditLogs.organizationId, id));
  await cleanupTenants();
});

describe("agent CRUD", () => {
  it("creates a generic agent with safe defaults (the tenant already has a default agent, so it is not the default)", async () => {
    const res = await http(owner, "POST", "/api/agents", { name: "Front desk", personaName: "Maya" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Front desk",
      personaName: "Maya",
      companyName: null,
      status: "active",
      isDefault: false,
      promptTemplateKey: "generic",
      language: "en-IN",
      voice: null,
      tone: "professional",
      behaviour: { maxResponseSentences: 3, endCallWhenDone: true, conversationQuestions: [] },
      enabledTools: ["end_call"],
      moduleConfig: {},
      knowledge: [],
    });
    expect(res.body.data.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("lists, gets and partially updates (nested settings merge)", async () => {
    const created = await http(owner, "POST", "/api/agents", {
      name: "Support",
      personaName: "Sam",
      behaviour: { maxResponseSentences: 2 },
      voice: "provider-voice-1",
    });
    expect(created.status).toBe(201);
    expect(created.body.data.isDefault).toBe(false);
    const id = created.body.data.id;

    const list = await http(owner, "GET", "/api/agents");
    expect(list.status).toBe(200);
    expect(list.body.data.map((a: { id: string }) => a.id)).toContain(id);
    expect(list.body.data[0].isDefault).toBe(true);

    const patched = await http(owner, "PATCH", `/api/agents/${id}`, {
      greeting: "Hello there",
      behaviour: { conversationQuestions: ["What is your name?"] },
      enabledTools: ["update_lead"],
      companyName: "Acme",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      greeting: "Hello there",
      companyName: "Acme",
      voice: "provider-voice-1",
      behaviour: { maxResponseSentences: 2, endCallWhenDone: true, conversationQuestions: ["What is your name?"] },
      enabledTools: ["update_lead", "end_call"], // end_call is always added
    });
    expect((await http(owner, "GET", `/api/agents/${id}`)).body.data.greeting).toBe("Hello there");

    // companyName can be cleared again
    const cleared = await http(owner, "PATCH", `/api/agents/${id}`, { companyName: null });
    expect(cleared.body.data.companyName).toBeNull();
  });

  it("defaults tools by template: end_call only for generic, the full list for sales_real_estate", async () => {
    const sales = await http(owner, "POST", "/api/agents", {
      name: "Sales one",
      personaName: "Priya",
      promptTemplateKey: "sales_real_estate",
      moduleConfig: { sales: { offerSlots: 2 } },
    });
    expect(sales.status).toBe(201);
    expect(sales.body.data.enabledTools).toEqual([...SALES_TOOL_NAMES]);
    expect(sales.body.data.moduleConfig).toEqual({ sales: { offerSlots: 2, autoBook: true } });
  });

  it("records audit events with field names only, never prompt text", async () => {
    const created = await http(owner, "POST", "/api/agents", { name: "Audited", personaName: "Au" });
    const id = created.body.data.id;
    await http(owner, "PATCH", `/api/agents/${id}`, { systemPrompt: "TOP-SECRET-PROMPT-TEXT", tone: "warm" });
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("agent.created");
    expect(actions).toContain("agent.updated");
    const updated = rows.find((r) => r.action === "agent.updated")!;
    expect(updated.metadata).toEqual({ changed: expect.arrayContaining(["systemPrompt", "tone"]) });
    expect(JSON.stringify(rows)).not.toContain("TOP-SECRET-PROMPT-TEXT");
  });
});

describe("validation", () => {
  it("requires the AI disclosure wording to still say it is an AI", async () => {
    const bad = await http(owner, "POST", "/api/agents", { name: "NoAI", personaName: "X", disclosureText: "Hi, I am Priya from the office." });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/disclosure/i);
    const good = await http(owner, "POST", "/api/agents", {
      name: "WithAI",
      personaName: "X",
      disclosureText: "Hello, this is an AI assistant calling for the office.",
    });
    expect(good.status).toBe(201);
    const badPatch = await http(owner, "PATCH", `/api/agents/${good.body.data.id}`, { disclosureText: "Just a normal person." });
    expect(badPatch.status).toBe(400);
  });

  it("rejects unknown tools, empty tool lists, bad numbers and unknown keys", async () => {
    const base = { name: "Strict", personaName: "S" };
    expect((await http(owner, "POST", "/api/agents", { ...base, enabledTools: ["not_a_tool"] })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, enabledTools: [] })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, behaviour: { maxResponseSentences: 9 } })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, behaviour: { conversationQuestions: ["a", "b", "c", "d"] } })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, moduleConfig: { sales: { offerSlots: 4 } } })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, language: "xx-XX" })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, disclosureEnabled: false })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { personaName: "NoName" })).status).toBe(400);
    expect((await http(owner, "POST", "/api/agents", { ...base, organizationId: B.orgId })).status).toBe(400);

    const ok = await http(owner, "POST", "/api/agents", { name: "Strict ok", personaName: "S" });
    const id = ok.body.data.id;
    expect((await http(owner, "PATCH", `/api/agents/${id}`, { isDefault: true })).status).toBe(400);
    expect((await http(owner, "PATCH", `/api/agents/${id}`, { status: "archived" })).status).toBe(400);
    expect((await http(owner, "PATCH", `/api/agents/${id}`, { bogus: 1 })).status).toBe(400);
    expect((await http(owner, "GET", "/api/agents/not-a-uuid")).status).toBe(400);
  });
});

describe("permissions", () => {
  it("AGENT is denied read and manage; MANAGER can read only; ADMIN and OWNER can manage", async () => {
    const seed = await http(owner, "POST", "/api/agents", { name: "Perm target", personaName: "P" });
    const id = seed.body.data.id;

    expect((await http(agentRole, "GET", "/api/agents")).status).toBe(403);
    expect((await http(agentRole, "GET", `/api/agents/${id}`)).status).toBe(403);
    expect((await http(agentRole, "POST", "/api/agents", { name: "x1", personaName: "x" })).status).toBe(403);

    expect((await http(manager, "GET", "/api/agents")).status).toBe(200);
    expect((await http(manager, "GET", `/api/agents/${id}`)).status).toBe(200);
    expect((await http(manager, "POST", "/api/agents", { name: "x2", personaName: "x" })).status).toBe(403);
    expect((await http(manager, "PATCH", `/api/agents/${id}`, { tone: "warm" })).status).toBe(403);
    expect((await http(manager, "POST", `/api/agents/${id}/archive`)).status).toBe(403);
    expect((await http(manager, "POST", `/api/agents/${id}/set-default`)).status).toBe(403);
    expect((await http(manager, "PUT", `/api/agents/${id}/knowledge`, { bindings: [] })).status).toBe(403);

    expect((await http(admin, "PATCH", `/api/agents/${id}`, { tone: "friendly" })).status).toBe(200);
    expect((await http(admin, "POST", "/api/agents", { name: "Admin made", personaName: "Ad" })).status).toBe(201);
    expect((await http(owner, "PATCH", `/api/agents/${id}`, { tone: "formal" })).status).toBe(200);
  });
});

describe("multiple agents in one organization", () => {
  it("keeps configuration and knowledge independent", async () => {
    const a1 = (await http(owner, "POST", "/api/agents", { name: "Multi 1", personaName: "One", tone: "warm", language: "hi-IN" })).body.data;
    const a2 = (await http(owner, "POST", "/api/agents", { name: "Multi 2", personaName: "Two", tone: "formal" })).body.data;
    const bind = await http(owner, "PUT", `/api/agents/${a1.id}/knowledge`, {
      bindings: [{ sourceType: "project", sourceId: A.projectId }],
    });
    expect(bind.status).toBe(200);
    await http(owner, "PATCH", `/api/agents/${a2.id}`, { greeting: "Only for two" });

    const r1 = (await http(owner, "GET", `/api/agents/${a1.id}`)).body.data;
    const r2 = (await http(owner, "GET", `/api/agents/${a2.id}`)).body.data;
    expect(r1).toMatchObject({ personaName: "One", tone: "warm", language: "hi-IN", greeting: null });
    expect(r1.knowledge).toEqual([{ sourceType: "project", sourceId: A.projectId }]);
    expect(r2).toMatchObject({ personaName: "Two", tone: "formal", language: "en-IN", greeting: "Only for two" });
    expect(r2.knowledge).toEqual([]);

    // Repository lookups the live call path will use.
    expect((await agentsRepository.findBoundToProject({ organizationId: A.orgId, projectId: A.projectId }))?.id).toBe(a1.id);
    const runtime = await agentsService.getRuntimeAgent(systemContext(A.orgId, "test"), { agentId: a2.id });
    expect(runtime?.personaName).toBe("Two");
  });
});

describe("tenant isolation", () => {
  it("org B can never see, change, archive or bind org A's agent, nor bind org A's project", async () => {
    const aAgent = (await http(owner, "POST", "/api/agents", { name: "Iso A agent", personaName: "IsoA" })).body.data;
    const bAgent = (await http(ownerB, "POST", "/api/agents", { name: "Iso B agent", personaName: "IsoB" })).body.data;

    expect((await http(ownerB, "GET", "/api/agents")).body.data.map((a: { id: string }) => a.id)).not.toContain(aAgent.id);
    expect((await http(ownerB, "GET", `/api/agents/${aAgent.id}`)).status).toBe(404);
    expect((await http(ownerB, "PATCH", `/api/agents/${aAgent.id}`, { personaName: "Hacked" })).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/agents/${aAgent.id}/archive`)).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/agents/${aAgent.id}/unarchive`)).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/agents/${aAgent.id}/set-default`)).status).toBe(404);
    expect(
      (await http(ownerB, "PUT", `/api/agents/${aAgent.id}/knowledge`, { bindings: [{ sourceType: "project", sourceId: B.projectId }] })).status,
    ).toBe(404);
    // B's own agent cannot bind A's project.
    const cross = await http(ownerB, "PUT", `/api/agents/${bAgent.id}/knowledge`, {
      bindings: [{ sourceType: "project", sourceId: A.projectId }],
    });
    expect(cross.status).toBe(400);

    expect((await http(owner, "GET", `/api/agents/${aAgent.id}`)).body.data.personaName).toBe("IsoA");
    expect(await agentsRepository.findById({ organizationId: B.orgId, id: aAgent.id })).toBeNull();
    expect(await agentsService.getRuntimeAgent(systemContext(B.orgId, "test"), { agentId: aAgent.id })).toBeNull();
    expect(await agentsRepository.findBoundToProject({ organizationId: B.orgId, projectId: A.projectId })).toBeNull();
  });

  it("the same agent name can exist in two organizations", async () => {
    expect((await http(owner, "POST", "/api/agents", { name: "Shared name", personaName: "S" })).status).toBe(201);
    expect((await http(ownerB, "POST", "/api/agents", { name: "Shared name", personaName: "S" })).status).toBe(201);
  });
});

describe("default agent invariants", () => {
  it("has one active default, cannot archive it, swaps atomically and keeps names unique case-insensitively", async () => {
    const first = (await http(ownerB, "POST", "/api/agents", { name: "Inv first", personaName: "F" })).body.data;
    const second = (await http(ownerB, "POST", "/api/agents", { name: "Inv second", personaName: "S" })).body.data;

    const defaults = async () =>
      (await http(ownerB, "GET", "/api/agents?includeArchived=true")).body.data.filter((a: { isDefault: boolean }) => a.isDefault);
    const before = await defaults();
    expect(before).toHaveLength(1);
    const currentDefaultId = before[0].id;

    const refuse = await http(ownerB, "POST", `/api/agents/${currentDefaultId}/archive`);
    expect(refuse.status).toBe(409);

    const target = [first, second].find((a) => a.id !== currentDefaultId)!;
    const swapped = await http(ownerB, "POST", `/api/agents/${target.id}/set-default`);
    expect(swapped.status).toBe(200);
    expect(swapped.body.data.isDefault).toBe(true);
    const after = await defaults();
    expect(after.map((a: { id: string }) => a.id)).toEqual([target.id]);

    // the previous default can now be archived, and then cannot become default
    expect((await http(ownerB, "POST", `/api/agents/${currentDefaultId}/archive`)).status).toBe(200);
    expect((await http(ownerB, "POST", `/api/agents/${currentDefaultId}/set-default`)).status).toBe(409);
    expect((await http(ownerB, "GET", "/api/agents")).body.data.map((a: { id: string }) => a.id)).not.toContain(currentDefaultId);
    expect((await http(ownerB, "GET", "/api/agents?includeArchived=true")).body.data.map((a: { id: string }) => a.id)).toContain(currentDefaultId);

    // case-insensitive unique names among active agents
    expect((await http(ownerB, "POST", "/api/agents", { name: "INV SECOND", personaName: "X" })).status).toBe(409);
    const other = (await http(ownerB, "POST", "/api/agents", { name: "Inv other", personaName: "O" })).body.data;
    expect((await http(ownerB, "PATCH", `/api/agents/${other.id}`, { name: "inv second" })).status).toBe(409);

    // an archived agent's name can be reused; then unarchiving the original conflicts
    const archivedName = (await db.select().from(agents).where(eq(agents.id, currentDefaultId)))[0].name;
    expect((await http(ownerB, "POST", "/api/agents", { name: archivedName, personaName: "Dup" })).status).toBe(201);
    expect((await http(ownerB, "POST", `/api/agents/${currentDefaultId}/unarchive`)).status).toBe(409);
  });

  it("unarchives an agent whose name is free, and the database refuses a second active default", async () => {
    const x = (await http(owner, "POST", "/api/agents", { name: "Unarch me", personaName: "U" })).body.data;
    expect((await http(owner, "POST", `/api/agents/${x.id}/archive`)).status).toBe(200);
    const back = await http(owner, "POST", `/api/agents/${x.id}/unarchive`);
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe("active");
    expect(back.body.data.isDefault).toBe(false);

    const [def] = (await http(owner, "GET", "/api/agents")).body.data.filter((a: { isDefault: boolean }) => a.isDefault);
    await expect(
      db.insert(agents).values({ organizationId: A.orgId, name: "Rogue default", personaName: "R", isDefault: true }),
    ).rejects.toThrow();
    expect(def).toBeTruthy();
  });
});

describe("knowledge bindings", () => {
  it("replaces the whole set, collapses duplicates and allows clearing", async () => {
    const agent = (await http(owner, "POST", "/api/agents", { name: "Knows", personaName: "K" })).body.data;
    const set = await http(owner, "PUT", `/api/agents/${agent.id}/knowledge`, {
      bindings: [
        { sourceType: "project", sourceId: A.projectId },
        { sourceType: "project", sourceId: A.projectId },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body.data.knowledge).toEqual([{ sourceType: "project", sourceId: A.projectId }]);

    expect((await http(owner, "PUT", `/api/agents/${agent.id}/knowledge`, { bindings: [] })).body.data.knowledge).toEqual([]);
    expect((await http(owner, "PUT", `/api/agents/${agent.id}/knowledge`, { bindings: [{ sourceType: "document", sourceId: A.projectId }] })).status).toBe(400);
    expect((await http(owner, "PUT", `/api/agents/${agent.id}/knowledge`, { bindings: [{ sourceType: "project", sourceId: "00000000-0000-4000-8000-000000000000" }] })).status).toBe(400);
    expect((await http(owner, "PUT", `/api/agents/${agent.id}/knowledge`, { bindings: [], extra: 1 })).status).toBe(400);
  });

  it("returns 403 for non-empty bindings when Sales is disabled, but always allows an empty list", async () => {
    const agent = (await http(ownerC, "POST", "/api/agents", { name: "No sales", personaName: "N" })).body.data;
    const denied = await http(ownerC, "PUT", `/api/agents/${agent.id}/knowledge`, {
      bindings: [{ sourceType: "project", sourceId: C.projectId }],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/Sales module/);
    expect((await http(ownerC, "PUT", `/api/agents/${agent.id}/knowledge`, { bindings: [] })).status).toBe(200);
  });

  it("blocks creating a sales_real_estate agent when Sales is off, but generic agents work", async () => {
    const blocked = await http(ownerC, "POST", "/api/agents", { name: "Sales try", personaName: "S", promptTemplateKey: "sales_real_estate" });
    expect(blocked.status).toBe(403);
    const generic = await http(ownerC, "POST", "/api/agents", { name: "Generic ok", personaName: "G" });
    expect(generic.status).toBe(201);
    const switchTemplate = await http(ownerC, "PATCH", `/api/agents/${generic.body.data.id}`, { promptTemplateKey: "sales_real_estate" });
    expect(switchTemplate.status).toBe(403);
  });
});
