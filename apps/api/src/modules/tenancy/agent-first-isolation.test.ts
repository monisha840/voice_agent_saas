/**
 * Tenant isolation for the agent-first surface: agents, agent phone numbers, knowledge bindings and calls.
 * Organization B must never read, change or attach to anything of organization A, over HTTP and in the database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db } from "../../db/client.js";
import { agentKnowledgeBindings, agentPhoneNumbers, agents, calls } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { callsService } from "../calls/calls.service.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { CapturingProvider, httpClient, randomPhone, relaxRateLimits, startTestApp } from "../../test/agent-first.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let B: TestTenant;
let cookieA = "";
let cookieB = "";
let adminB = "";
let aGenericAgentId = "";
let aLeadlessCallId = "";
let aPhoneNumber = "";
let aPhoneNumberId = "";

/** The Postgres error behind a drizzle failure. */
async function dbError(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await run();
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string; message: string; cause?: { code?: string; constraint_name?: string; message?: string } };
    return { code: e.cause?.code ?? e.code, constraint: e.cause?.constraint_name ?? e.constraint_name, message: e.cause?.message ?? e.message };
  }
  throw new Error("expected the database to reject the statement");
}

beforeAll(async () => {
  A = await createTenant("AI_A");
  B = await createTenant("AI_B");
  const adminBM = await createMember(B.orgId, "ADMIN");
  ({ app } = await startTestApp());
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  http = httpClient(baseUrl);
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
  adminB = await loginCookie(baseUrl, adminBM.email);

  const generic = await createDefaultAgent(A.orgId, {
    name: "A generic",
    promptTemplateKey: "generic",
    enabledTools: ["end_call"],
    isDefault: false,
    moduleConfig: {},
  });
  aGenericAgentId = generic.id;
  aPhoneNumber = randomPhone();
  const added = await http(cookieA, "POST", `/api/agents/${generic.id}/phone-numbers`, { phoneNumber: aPhoneNumber });
  expect(added.status).toBe(201);
  aPhoneNumberId = added.body.data.id;
  const leadless = await callsService.createCall(systemContext(A.orgId, "test"), {
    agentId: generic.id,
    callType: "outbound",
    counterpartyNumber: randomPhone(),
  });
  aLeadlessCallId = leadless.id;
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});

describe("HTTP: org B against org A's agents", () => {
  it("cannot list or get them", async () => {
    const list = await http(cookieB, "GET", "/api/agents?includeArchived=true");
    expect(list.status).toBe(200);
    const ids = list.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(B.agentId);
    expect(ids).not.toContain(A.agentId);
    expect(ids).not.toContain(aGenericAgentId);
    expect(JSON.stringify(list.body)).not.toContain("A generic");

    expect((await http(cookieB, "GET", `/api/agents/${A.agentId}`)).status).toBe(404);
    expect((await http(cookieB, "GET", `/api/agents/${aGenericAgentId}`)).status).toBe(404);
    // org A still reads its own
    expect((await http(cookieA, "GET", `/api/agents/${aGenericAgentId}`)).status).toBe(200);
  });

  it("cannot PATCH, archive, unarchive, set default or bind knowledge on them (404, and nothing changes)", async () => {
    const before = (await db.select().from(agents).where(eq(agents.id, aGenericAgentId)))[0];
    expect((await http(adminB, "PATCH", `/api/agents/${aGenericAgentId}`, { name: "hijacked", greeting: "pwned" })).status).toBe(404);
    expect((await http(adminB, "POST", `/api/agents/${aGenericAgentId}/archive`)).status).toBe(404);
    expect((await http(adminB, "POST", `/api/agents/${aGenericAgentId}/unarchive`)).status).toBe(404);
    expect((await http(adminB, "POST", `/api/agents/${A.agentId}/set-default`)).status).toBe(404);
    expect((await http(adminB, "PUT", `/api/agents/${aGenericAgentId}/knowledge`, { bindings: [] })).status).toBe(404);
    expect(
      (await http(adminB, "PUT", `/api/agents/${aGenericAgentId}/knowledge`, { bindings: [{ sourceType: "project", sourceId: B.projectId }] })).status,
    ).toBe(404);
    const after = (await db.select().from(agents).where(eq(agents.id, aGenericAgentId)))[0];
    expect(after).toEqual(before);
    expect((await db.select().from(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.agentId, aGenericAgentId)))).toHaveLength(0);
  });

  it("cannot bind its own agent to org A's project (the project is invisible to it)", async () => {
    const res = await http(adminB, "PUT", `/api/agents/${B.agentId}/knowledge`, { bindings: [{ sourceType: "project", sourceId: A.projectId }] });
    expect(res.status).toBe(400);
    expect(await db.select().from(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.agentId, B.agentId))).toHaveLength(0);
  });

  it("cannot list, add or remove phone numbers of org A's agent (404), and A's number stays", async () => {
    expect((await http(adminB, "GET", `/api/agents/${aGenericAgentId}/phone-numbers`)).status).toBe(404);
    expect((await http(adminB, "POST", `/api/agents/${aGenericAgentId}/phone-numbers`, { phoneNumber: randomPhone() })).status).toBe(404);
    expect((await http(adminB, "DELETE", `/api/agents/${aGenericAgentId}/phone-numbers/${aPhoneNumberId}`)).status).toBe(404);
    // B's own agent cannot remove A's number id either
    expect((await http(adminB, "DELETE", `/api/agents/${B.agentId}/phone-numbers/${aPhoneNumberId}`)).status).toBe(404);
    expect(await db.select().from(agentPhoneNumbers).where(eq(agentPhoneNumbers.id, aPhoneNumberId))).toHaveLength(1);
  });

  it("A's number cannot be claimed by B, and an inbound call to it belongs to A", async () => {
    expect((await http(adminB, "POST", `/api/agents/${B.agentId}/phone-numbers`, { phoneNumber: aPhoneNumber })).status).toBe(409);
    const inbound = await callsService.startInboundCall({ dialedNumber: aPhoneNumber, callerNumber: randomPhone() });
    expect(inbound.organizationId).toBe(A.orgId);
    expect(inbound.agentId).toBe(aGenericAgentId);
  });
});

describe("HTTP: org B placing calls with org A's records", () => {
  it("cannot place a call with org A's agent (404, nothing created in either organization)", async () => {
    const capture = new CapturingProvider();
    setTelephonyProvider(capture);
    try {
      const before = (await db.select({ id: calls.id }).from(calls)).length;
      for (const callType of ["test", "outbound"] as const) {
        const res = await http(cookieB, "POST", "/api/calls", { agentId: aGenericAgentId, callType, toNumber: randomPhone() });
        expect(res.status).toBe(404);
      }
      expect((await db.select({ id: calls.id }).from(calls)).length).toBe(before);
      expect(capture.calls).toHaveLength(0);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("cannot place a call to org A's lead, with or without an agent of its own (404)", async () => {
    const capture = new CapturingProvider();
    setTelephonyProvider(capture);
    try {
      const before = (await db.select({ id: calls.id }).from(calls)).length;
      expect((await http(cookieB, "POST", "/api/calls", { agentId: B.agentId, callType: "outbound", leadId: A.leadId })).status).toBe(404);
      expect((await http(cookieB, "POST", "/api/calls", { agentId: A.agentId, callType: "outbound", leadId: A.leadId })).status).toBe(404);
      expect((await http(cookieB, "POST", `/api/leads/${A.leadId}/call`)).status).toBe(404);
      expect((await http(cookieB, "POST", `/api/leads/${B.leadId}/call`, { agentId: A.agentId })).status).toBe(404);
      expect((await db.select({ id: calls.id }).from(calls)).length).toBe(before);
      expect(capture.calls).toHaveLength(0);
    } finally {
      setTelephonyProvider(null);
    }
  });
});

describe("HTTP: org B reading org A's calls", () => {
  it("GET /api/calls never leaks org A's calls, with or without agentId / callType filters", async () => {
    const plain = await http(cookieB, "GET", "/api/calls");
    expect(plain.status).toBe(200);
    expect(plain.body.data.map((c: { id: string }) => c.id)).toEqual([B.callId]);

    for (const agentId of [A.agentId, aGenericAgentId]) {
      const filtered = await http(cookieB, "GET", `/api/calls?agentId=${agentId}`);
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toEqual([]);
    }
    const byType = await http(cookieB, "GET", "/api/calls?callType=outbound");
    expect(byType.body.data.map((c: { id: string }) => c.id)).not.toContain(aLeadlessCallId);
    expect(JSON.stringify([plain.body, byType.body])).not.toContain("AI_A");

    // sanity: A does see them
    const own = await http(cookieA, "GET", `/api/calls?agentId=${aGenericAgentId}`);
    expect(own.body.data.map((c: { id: string }) => c.id)).toContain(aLeadlessCallId);
  });

  it("the detail of org A's calls (lead-based and leadless) is a 404 for org B", async () => {
    expect((await http(cookieB, "GET", `/api/calls/${A.callId}`)).status).toBe(404);
    expect((await http(cookieB, "GET", `/api/calls/${aLeadlessCallId}`)).status).toBe(404);
    expect((await http(cookieA, "GET", `/api/calls/${aLeadlessCallId}`)).status).toBe(200);
  });
});

describe("database: composite foreign keys", () => {
  it("rejects a call in org B that references org A's agent", async () => {
    const err = await dbError(() => db.insert(calls).values({ organizationId: B.orgId, agentId: A.agentId, status: "initiating" }));
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe("calls_org_agent_fk");
  });

  it("rejects pointing an existing org B call at org A's agent", async () => {
    const err = await dbError(() => db.update(calls).set({ agentId: A.agentId }).where(eq(calls.id, B.callId)));
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe("calls_org_agent_fk");
    expect((await db.select().from(calls).where(eq(calls.id, B.callId)))[0].agentId).toBe(B.agentId);
  });

  it("rejects attaching org B's lead to a call of org A (insert and update)", async () => {
    const inserted = await dbError(() =>
      db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, leadId: B.leadId, status: "initiating" }),
    );
    expect(inserted.code).toBe("23503");
    expect(inserted.constraint).toBe("calls_org_lead_fk");

    const updated = await dbError(() => db.update(calls).set({ leadId: B.leadId }).where(eq(calls.id, aLeadlessCallId)));
    expect(updated.code).toBe("23503");
    expect(updated.constraint).toBe("calls_org_lead_fk");
    expect((await db.select().from(calls).where(eq(calls.id, aLeadlessCallId)))[0].leadId).toBeNull();
  });

  it("rejects an agent phone number or a knowledge binding that crosses organizations", async () => {
    const phone = await dbError(() =>
      db.insert(agentPhoneNumbers).values({ organizationId: B.orgId, agentId: A.agentId, phoneNumber: randomPhone() }),
    );
    expect(phone.code).toBe("23503");
    const binding = await dbError(() =>
      db.insert(agentKnowledgeBindings).values({ organizationId: B.orgId, agentId: A.agentId, sourceType: "project", sourceId: B.projectId }),
    );
    expect(binding.code).toBe("23503");
  });

  it("still allows legitimate same-organization rows (the constraints are not over-strict)", async () => {
    const [ok] = await db
      .insert(calls)
      .values({ organizationId: A.orgId, agentId: A.agentId, leadId: A.leadId, status: "initiating" })
      .returning();
    expect(ok.organizationId).toBe(A.orgId);
    const [leadless] = await db.insert(calls).values({ organizationId: B.orgId, agentId: B.agentId, status: "initiating" }).returning();
    expect(leadless.leadId).toBeNull();
  });
});
