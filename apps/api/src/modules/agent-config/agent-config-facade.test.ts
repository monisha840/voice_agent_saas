import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { agentConfigs, agentKnowledgeBindings, agents, calls } from "../../db/schema.js";
import { userContext } from "../../auth/context.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { callsService } from "../calls/calls.service.js";
import { callRuntime } from "../calls/call-runtime.js";
import { cleanupTenants, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const SALES_TOOLS = [
  "get_project_details",
  "get_project_price",
  "get_project_configurations",
  "get_project_location",
  "get_nearby_places",
  "check_visit_slots",
  "book_site_visit",
  "update_lead",
  "mark_not_interested",
  "request_follow_up",
  "end_call",
];

let app: App;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let cookieA: string;
let cookieB: string;
let project2Id: string;
let lead2Id: string;

async function http(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, body: json && typeof json === "object" && "data" in json ? json.data : json };
}

const agentById = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
const ctxA = () => userContext(A.orgId, A.userId, "OWNER");

beforeAll(async () => {
  A = await createTenant("FA");
  B = await createTenant("FB");
  const p2 = await projectsRepository.create({ organizationId: A.orgId, name: "Other Towers", location: "Elsewhere" });
  project2Id = p2.id;
  lead2Id = (await leadsRepository.create({ organizationId: A.orgId, projectId: p2.id, name: "Lead Two", phone: "+919000010077" })).id;
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
});

afterAll(async () => {
  await app.close();
  const orgs = [A.orgId, B.orgId];
  await db.delete(calls).where(inArray(calls.organizationId, orgs)); // calls restrict-reference agents
  await db.delete(agentKnowledgeBindings).where(inArray(agentKnowledgeBindings.organizationId, orgs));
  await db.delete(agents).where(inArray(agents.organizationId, orgs));
  await db.delete(agentConfigs).where(inArray(agentConfigs.organizationId, orgs));
  await cleanupTenants();
});

describe("/api/agent-config write-through to agents", () => {
  it("PUT org default updates the default agent with the backfill mapping; empty allowedTools = full list", async () => {
    const res = await http(cookieA, "PUT", "/api/agent-config", {
      agentName: "Meera",
      companyName: "Acme Realty",
      greeting: "Namaste!",
      disclosureText: "This call is AI assisted.",
      language: "hi-IN",
      tone: "friendly",
      callObjective: "Book a site visit",
      qualificationQuestions: ["Budget?", "Timeline?"],
      callBehaviour: { maxResponseSentences: 2, endCallWhenDone: false },
      allowedTools: [],
      siteVisitBehaviour: { offerSlots: 2, autoBook: false },
      extraInstructions: "Be brief.",
    });
    expect(res.status).toBe(200);
    const a = await agentById(A.agentId);
    expect(a).toMatchObject({
      personaName: "Meera",
      companyName: "Acme Realty",
      greeting: "Namaste!",
      disclosureText: "This call is AI assisted.",
      language: "hi-IN",
      tone: "friendly",
      callObjective: "Book a site visit",
      extraInstructions: "Be brief.",
      promptTemplateKey: "sales_real_estate",
      isDefault: true,
      status: "active",
    });
    expect(a.behaviour).toEqual({ maxResponseSentences: 2, endCallWhenDone: false, conversationQuestions: ["Budget?", "Timeline?"] });
    expect(a.enabledTools).toEqual(SALES_TOOLS);
    expect(a.moduleConfig).toEqual({ sales: { offerSlots: 2, autoBook: false } });
  });

  it("a non-empty allowedTools list gets end_call appended", async () => {
    const res = await http(cookieA, "PUT", "/api/agent-config", { allowedTools: ["get_project_price", "update_lead"] });
    expect(res.status).toBe(200);
    expect((await agentById(A.agentId)).enabledTools).toEqual(["get_project_price", "update_lead", "end_call"]);
  });

  it("round trip: a call of the default agent runs with the new persona, greeting, tone, language and tools", async () => {
    const call = await callsService.createCall(ctxA(), {});
    expect(call.agentId).toBe(A.agentId);
    const full = await callsRepository.findByIdAnyOrg({ id: call.id });
    const runtime = await callRuntime.build(ctxA(), full!);
    expect(runtime.config).toMatchObject({ agentName: "Meera", greeting: "Namaste!", tone: "friendly", language: "hi-IN" });
    expect(runtime.languageCode).toBe("hi-IN");
    expect(runtime.effectiveTools).toEqual(expect.arrayContaining(["end_call"]));
    expect(runtime.effectiveTools).not.toContain("book_site_visit");
  });

  it("PUT with projectId creates then updates a project-bound agent; only that project's leads use it", async () => {
    const before = (await db.select().from(agents).where(eq(agents.organizationId, A.orgId))).length;
    const r1 = await http(cookieA, "PUT", "/api/agent-config", { projectId: A.projectId, agentName: "Riya", tone: "warm" });
    expect(r1.status).toBe(200);
    const rows = await db.select().from(agents).where(eq(agents.organizationId, A.orgId));
    expect(rows.length).toBe(before + 1);
    const created = rows.find((r) => r.name === `${A.projectName} agent`)!;
    expect(created).toMatchObject({ personaName: "Riya", isDefault: false, status: "active", promptTemplateKey: "sales_real_estate" });
    const bindings = await db.select().from(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.agentId, created.id));
    expect(bindings.map((b) => [b.sourceType, b.sourceId])).toEqual([["project", A.projectId]]);

    // second PUT updates the same agent, no new rows
    const r2 = await http(cookieA, "PUT", "/api/agent-config", { projectId: A.projectId, greeting: "Hello from Riya" });
    expect(r2.status).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.organizationId, A.orgId))).length).toBe(before + 1);
    expect(await agentById(created.id)).toMatchObject({ personaName: "Riya", greeting: "Hello from Riya" });

    expect(await callsService.resolveAgentId(ctxA(), { leadId: A.leadId })).toBe(created.id);
    expect(await callsService.resolveAgentId(ctxA(), { leadId: lead2Id })).toBe(A.agentId);
    expect(await callsService.resolveAgentId(ctxA(), {})).toBe(A.agentId);
  });

  it("DELETE with projectId archives the project agent and calls fall back to the default", async () => {
    const bound = (await db.select().from(agents).where(eq(agents.name, `${A.projectName} agent`)))[0];
    const res = await http(cookieA, "DELETE", `/api/agent-config?projectId=${A.projectId}`);
    expect(res.status).toBe(200);
    expect((await agentById(bound.id)).status).toBe("archived");
    expect(await callsService.resolveAgentId(ctxA(), { leadId: A.leadId })).toBe(A.agentId);

    // a new override gets a fresh agent (the archived one's name is free again), the old one stays archived
    expect((await http(cookieA, "PUT", "/api/agent-config", { projectId: A.projectId, agentName: "Zoya" })).status).toBe(200);
    const resolved = await callsService.resolveAgentId(ctxA(), { leadId: A.leadId });
    expect(resolved).not.toBe(bound.id);
    expect((await agentById(resolved)).personaName).toBe("Zoya");
  });

  it("an override for a project bound to the default agent never converts the default", async () => {
    await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId: A.agentId, sourceType: "project", sourceId: project2Id });
    const defaultBefore = await agentById(A.agentId);
    expect((await http(cookieA, "PUT", "/api/agent-config", { projectId: project2Id, agentName: "Only2" })).status).toBe(200);
    expect((await agentById(A.agentId)).personaName).toBe(defaultBefore.personaName);
    const resolved = await callsService.resolveAgentId(ctxA(), { leadId: lead2Id });
    expect(resolved).not.toBe(A.agentId);
    expect((await agentById(resolved)).personaName).toBe("Only2");
    // resetting never archives the default
    expect((await http(cookieA, "DELETE", `/api/agent-config?projectId=${project2Id}`)).status).toBe(200);
    expect((await agentById(resolved)).status).toBe("archived");
    expect((await agentById(A.agentId)).status).toBe("active");
  });

  it("tenant isolation: org B's PUT never touches org A's agents", async () => {
    const snapshot = JSON.stringify(await db.select().from(agents).where(eq(agents.organizationId, A.orgId)));
    expect((await http(cookieB, "PUT", "/api/agent-config", { agentName: "BeeBee", greeting: "B only" })).status).toBe(200);
    expect(JSON.stringify(await db.select().from(agents).where(eq(agents.organizationId, A.orgId)))).toBe(snapshot);
    expect(await agentById(B.agentId)).toMatchObject({ personaName: "BeeBee", greeting: "B only" });
    // cross-tenant project is not visible
    expect((await http(cookieB, "PUT", "/api/agent-config", { projectId: A.projectId, agentName: "X" })).status).toBe(404);
  });

  it("DELETE without projectId resets the default agent to the built-in defaults (not archived)", async () => {
    expect((await http(cookieA, "DELETE", "/api/agent-config")).status).toBe(200);
    const a = await agentById(A.agentId);
    expect(a).toMatchObject({
      personaName: "Priya",
      companyName: null,
      greeting: null,
      disclosureText: null,
      callObjective: null,
      extraInstructions: null,
      language: "en-IN",
      tone: "professional",
      status: "active",
      isDefault: true,
    });
    expect(a.behaviour).toEqual({ maxResponseSentences: 3, endCallWhenDone: true, conversationQuestions: [] });
    expect(a.enabledTools).toEqual(SALES_TOOLS);
    expect(a.moduleConfig).toEqual({ sales: { offerSlots: 3, autoBook: true } });
  });

  it("recreates a default agent when the organization has none", async () => {
    await db.update(agents).set({ status: "archived" }).where(eq(agents.id, B.agentId));
    expect((await http(cookieB, "PUT", "/api/agent-config", { agentName: "Fresh" })).status).toBe(200);
    const created = (
      await db.select().from(agents).where(and(eq(agents.organizationId, B.orgId), eq(agents.isDefault, true), eq(agents.status, "active")))
    )[0];
    expect(created).toMatchObject({ name: "Default agent", personaName: "Fresh", promptTemplateKey: "sales_real_estate" });
  });

  it("marks the routes deprecated", async () => {
    for (const [method, path] of [
      ["GET", "/api/agent-config"],
      ["PUT", "/api/agent-config"],
      ["DELETE", "/api/agent-config"],
    ] as const) {
      const res = await http(cookieA, method, path, method === "PUT" ? { tone: "professional" } : undefined);
      expect(res.headers.get("deprecation")).toBe("true");
      expect(res.headers.get("link")).toBe('</api/agents>; rel="successor-version"');
    }
  });
});
