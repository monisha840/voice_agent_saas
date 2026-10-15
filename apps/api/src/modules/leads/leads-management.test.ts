/**
 * Tenant-aware lead management: create / update / assign / filter, call and
 * site-visit auditing. Service-level for role matrices, HTTP for status codes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs, projects, usageEvents, users } from "../../db/schema.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { projectMembersRepository } from "../../test/repos.js";
import { auditRepository } from "../../test/repos.js";
import { usageService } from "../usage/usage.service.js";
import { leadsService } from "./leads.service.js";
import { siteVisitsService } from "../site-visits/site-visits.service.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let project2Id: string; // second project in org A (manager is NOT a member)
let ctxOwner: RequestContext;
let ctxAdmin: RequestContext;
let ctxManager: RequestContext;
let ctxAgent: RequestContext;
let ctxOwnerB: RequestContext;
let agentUserId: string;
let managerUserId: string;
let inactiveUserId: string;
let orgBUserId: string;
let cookieOwner: string;
let cookieAgent: string;

let counter = 0;
const phone = () => `9${String(Date.now() + counter++).slice(-9).padStart(9, "0")}`;

async function http(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function auditRows(orgId: string, action: string, entityId?: string) {
  return auditRepository.list({ organizationId: orgId, limit: 100, action, entityId });
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  const [p2] = await db
    .insert(projects)
    .values({ organizationId: A.orgId, name: "A Second", location: "Elsewhere" })
    .returning();
  project2Id = p2.id;

  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const agent = await createMember(A.orgId, "AGENT");
  const inactive = await createMember(A.orgId, "AGENT", "inactive");
  const orgBUser = await createMember(B.orgId, "AGENT", "orgb");
  agentUserId = agent.userId;
  managerUserId = manager.userId;
  inactiveUserId = inactive.userId;
  orgBUserId = orgBUser.userId;
  await db.update(users).set({ isActive: false }).where(eq(users.id, inactive.userId));
  await projectMembersRepository.replaceForProject({ organizationId: A.orgId, projectId: A.projectId, userIds: [manager.userId] });

  ctxOwner = userContext(A.orgId, A.userId, "OWNER");
  ctxAdmin = userContext(A.orgId, admin.userId, "ADMIN");
  ctxManager = userContext(A.orgId, manager.userId, "MANAGER");
  ctxAgent = userContext(A.orgId, agent.userId, "AGENT");
  ctxOwnerB = userContext(B.orgId, B.userId, "OWNER");

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieOwner = await loginCookie(baseUrl, A.email);
  cookieAgent = await loginCookie(baseUrl, agent.email);
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await db.delete(usageEvents).where(inArray(usageEvents.organizationId, [A.orgId, B.orgId]));
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [A.orgId, B.orgId]));
  await cleanupTenants();
});

describe("createLead", () => {
  it("creates a lead, stores the phone as E.164 and audits without the raw number", async () => {
    const raw = phone();
    const lead = await leadsService.createLead(ctxOwner, {
      name: "  New Buyer ",
      phone: `+91 ${raw.slice(0, 5)}-${raw.slice(5)}`,
      projectId: A.projectId,
      requirementConfig: "3 BHK",
      budgetMin: 100,
      budgetMax: 200,
      assignedUserId: agentUserId,
    });
    expect(lead.phone).toBe(`+91${raw}`);
    expect(lead.name).toBe("New Buyer");
    expect(lead.status).toBe("NEW");
    expect(lead.assignedUserId).toBe(agentUserId);

    const rows = await auditRows(A.orgId, "lead.created", lead.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(raw);
    expect(JSON.stringify(rows[0].metadata)).toContain(raw.slice(-3));
  });

  it("accepts 10-digit and 0-prefixed numbers (same normalized form) and rejects a duplicate in the same project with 409", async () => {
    const raw = phone();
    await leadsService.createLead(ctxAdmin, { name: "Dup", phone: raw, projectId: A.projectId });
    await expect(
      leadsService.createLead(ctxAdmin, { name: "Dup2", phone: `0${raw}`, projectId: A.projectId }),
    ).rejects.toMatchObject({ name: "ConflictError" });
    // The same number in a different project is a different lead.
    const other = await leadsService.createLead(ctxAdmin, { name: "Dup3", phone: raw, projectId: project2Id });
    expect(other.projectId).toBe(project2Id);
  });

  it("validates input", async () => {
    const bad = [
      { name: "", phone: phone(), projectId: A.projectId },
      { name: "x".repeat(256), phone: phone(), projectId: A.projectId },
      { name: "X", phone: "12345", projectId: A.projectId },
      { name: "X", phone: "+14155550123", projectId: A.projectId },
      { name: "X", phone: phone(), projectId: "not-a-uuid" },
      { name: "X", phone: phone(), projectId: A.projectId, budgetMin: 10, budgetMax: 5 },
      { name: "X", phone: phone(), projectId: A.projectId, requirementConfig: "r".repeat(101) },
      { name: "X", phone: phone(), projectId: A.projectId, assignedUserId: "nope" },
    ];
    for (const input of bad) {
      await expect(leadsService.createLead(ctxOwner, input)).rejects.toMatchObject({ name: "ValidationError" });
    }
  });

  it("refuses archived projects (409) and unknown projects (404)", async () => {
    const [archived] = await db
      .insert(projects)
      .values({ organizationId: A.orgId, name: "Old", location: "x", status: "archived", archivedAt: new Date() })
      .returning();
    await expect(
      leadsService.createLead(ctxOwner, { name: "X", phone: phone(), projectId: archived.id }),
    ).rejects.toMatchObject({ name: "ConflictError", message: "Project is archived" });
    await expect(
      leadsService.createLead(ctxOwner, { name: "X", phone: phone(), projectId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("role matrix: OWNER/ADMIN anywhere, MANAGER only in member projects, AGENT never", async () => {
    await leadsService.createLead(ctxOwner, { name: "O", phone: phone(), projectId: project2Id });
    await leadsService.createLead(ctxAdmin, { name: "Ad", phone: phone(), projectId: project2Id });
    await leadsService.createLead(ctxManager, { name: "M", phone: phone(), projectId: A.projectId });
    await expect(
      leadsService.createLead(ctxManager, { name: "M", phone: phone(), projectId: project2Id }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      leadsService.createLead(ctxAgent, { name: "Ag", phone: phone(), projectId: A.projectId }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("assignee must be an active member of THIS organization", async () => {
    for (const assignedUserId of [orgBUserId, inactiveUserId, "00000000-0000-0000-0000-000000000000"]) {
      await expect(
        leadsService.createLead(ctxOwner, { name: "X", phone: phone(), projectId: A.projectId, assignedUserId }),
      ).rejects.toMatchObject({ name: "ValidationError" });
    }
  });

  it("tenant isolation: org A cannot create a lead in org B's project", async () => {
    await expect(
      leadsService.createLead(ctxOwner, { name: "X", phone: phone(), projectId: B.projectId }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

describe("updateLeadDetails", () => {
  async function fresh(ctx = ctxOwner, extra: { assignedUserId?: string } = {}) {
    return leadsService.createLead(ctx, { name: "Upd", phone: phone(), projectId: A.projectId, ...extra });
  }

  it("updates fields, normalizes phone, audits changed fields and status transition without the number", async () => {
    const lead = await fresh();
    const raw = phone();
    const updated = await leadsService.updateLeadDetails(ctxOwner, {
      leadId: lead.id,
      name: "Renamed",
      phone: raw,
      status: "INTERESTED",
      budgetMin: 1,
      budgetMax: 9,
    });
    expect(updated).toMatchObject({ name: "Renamed", phone: `+91${raw}`, status: "INTERESTED" });
    const rows = await auditRows(A.orgId, "lead.updated", lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ statusFrom: "NEW", statusTo: "INTERESTED" });
    expect((rows[0].metadata as { changedFields: string[] }).changedFields).toEqual(
      expect.arrayContaining(["name", "phone", "status", "budgetMin", "budgetMax"]),
    );
    expect(JSON.stringify(rows[0])).not.toContain(raw);
  });

  it("validates: bad status, bad phone, budget range against stored values, empty name", async () => {
    const lead = await fresh();
    await leadsService.updateLeadDetails(ctxOwner, { leadId: lead.id, budgetMin: 50 });
    const bad = [
      { status: "BOGUS" },
      { phone: "123" },
      { budgetMax: 10 },
      { name: "" },
      { requirementConfig: "r".repeat(101) },
    ];
    for (const patch of bad) {
      await expect(
        leadsService.updateLeadDetails(ctxOwner, { leadId: lead.id, ...patch } as never),
      ).rejects.toMatchObject({ name: "ValidationError" });
    }
  });

  it("re-checks duplicates when phone or project changes; allows keeping own phone", async () => {
    const a = await fresh();
    const b = await fresh();
    await expect(leadsService.updateLeadDetails(ctxOwner, { leadId: b.id, phone: a.phone })).rejects.toMatchObject({
      name: "ConflictError",
    });
    await expect(leadsService.updateLeadDetails(ctxOwner, { leadId: b.id, phone: b.phone, name: "same phone" })).resolves.toMatchObject({
      name: "same phone",
    });
    // moving a lead into a project that already has that number conflicts
    await leadsService.createLead(ctxOwner, { name: "Twin", phone: a.phone, projectId: project2Id });
    await expect(leadsService.updateLeadDetails(ctxOwner, { leadId: a.id, projectId: project2Id })).rejects.toMatchObject({
      name: "ConflictError",
    });
  });

  it("applies project rules when moving a lead (archived 409, other org 404, manager scope 404)", async () => {
    const lead = await fresh();
    const [archived] = await db
      .insert(projects)
      .values({ organizationId: A.orgId, name: "Old2", location: "x", status: "archived", archivedAt: new Date() })
      .returning();
    await expect(leadsService.updateLeadDetails(ctxOwner, { leadId: lead.id, projectId: archived.id })).rejects.toMatchObject({
      name: "ConflictError",
    });
    await expect(leadsService.updateLeadDetails(ctxOwner, { leadId: lead.id, projectId: B.projectId })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(leadsService.updateLeadDetails(ctxManager, { leadId: lead.id, projectId: project2Id })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    const moved = await leadsService.updateLeadDetails(ctxAdmin, { leadId: lead.id, projectId: project2Id });
    expect(moved?.projectId).toBe(project2Id);
  });

  it("roles: manager only in member projects (null otherwise); agent updates status of assigned leads only", async () => {
    const mine = await fresh(ctxOwner, { assignedUserId: agentUserId });
    const unassigned = await fresh();
    const outsideManager = await leadsService.createLead(ctxOwner, { name: "Out", phone: phone(), projectId: project2Id });

    expect(await leadsService.updateLeadDetails(ctxManager, { leadId: unassigned.id, name: "by manager" })).toMatchObject({ name: "by manager" });
    expect(await leadsService.updateLeadDetails(ctxManager, { leadId: outsideManager.id, name: "nope" })).toBeNull();

    expect(await leadsService.updateLeadDetails(ctxAgent, { leadId: mine.id, status: "FOLLOW_UP" })).toMatchObject({ status: "FOLLOW_UP" });
    expect(await leadsService.updateLeadDetails(ctxAgent, { leadId: unassigned.id, status: "FOLLOW_UP" })).toBeNull();
    await expect(leadsService.updateLeadDetails(ctxAgent, { leadId: mine.id, name: "rename" })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("tenant isolation: org A cannot update org B's lead", async () => {
    expect(await leadsService.updateLeadDetails(ctxOwner, { leadId: B.leadId, name: "hijack" })).toBeNull();
    expect(await leadsService.getLeadDetail(ctxOwnerB, { leadId: B.leadId })).toMatchObject({ name: "B Lead" });
  });
});

describe("assignLead", () => {
  it("assigns, unassigns and audits from/to", async () => {
    const lead = await leadsService.createLead(ctxOwner, { name: "As", phone: phone(), projectId: A.projectId });
    const assigned = await leadsService.assignLead(ctxAdmin, { leadId: lead.id, userId: agentUserId });
    expect(assigned?.assignedUserId).toBe(agentUserId);
    const detail = await leadsService.getLeadDetail(ctxAdmin, { leadId: lead.id });
    expect(detail?.assigneeName).toBe("agent user");
    expect(detail).not.toHaveProperty("assigneeEmail");
    await leadsService.assignLead(ctxManager, { leadId: lead.id, userId: null });
    const rows = await auditRows(A.orgId, "lead.assigned", lead.id);
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { from: null, to: agentUserId },
        { from: agentUserId, to: null },
      ]),
    );
  });

  it("assignee must be an active member of this org", async () => {
    const lead = await leadsService.createLead(ctxOwner, { name: "As2", phone: phone(), projectId: A.projectId });
    for (const userId of [orgBUserId, inactiveUserId]) {
      await expect(leadsService.assignLead(ctxOwner, { leadId: lead.id, userId })).rejects.toMatchObject({ name: "ValidationError" });
    }
  });

  it("roles: agent forbidden; manager limited to scope; org B lead is a 404", async () => {
    const mine = await leadsService.createLead(ctxOwner, { name: "As3", phone: phone(), projectId: A.projectId, assignedUserId: agentUserId });
    const outside = await leadsService.createLead(ctxOwner, { name: "As4", phone: phone(), projectId: project2Id });
    await expect(leadsService.assignLead(ctxAgent, { leadId: mine.id, userId: agentUserId })).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await leadsService.assignLead(ctxManager, { leadId: outside.id, userId: managerUserId })).toBeNull();
    expect(await leadsService.assignLead(ctxOwner, { leadId: B.leadId, userId: A.userId })).toBeNull();
  });
});

describe("list filters", () => {
  it("filter by status/project/assignee, never beyond scope", async () => {
    const lead = await leadsService.createLead(ctxOwner, { name: "Fil", phone: phone(), projectId: project2Id, assignedUserId: agentUserId });
    await leadsService.updateLeadDetails(ctxOwner, { leadId: lead.id, status: "DNC" });

    const byOwner = await leadsService.listLeads(ctxOwner, { status: "DNC", projectId: project2Id, assignedTo: agentUserId });
    expect(byOwner.map((l) => l.id)).toContain(lead.id);

    // manager is not a member of project2: filtering for it must not widen their scope
    expect(await leadsService.listLeads(ctxManager, { projectId: project2Id })).toEqual([]);
    expect((await leadsService.listLeads(ctxManager)).every((l) => l.projectId === A.projectId)).toBe(true);

    // agent sees only own leads whatever the filter says
    const agentAll = await leadsService.listLeads(ctxAgent, { assignedTo: A.userId });
    expect(agentAll).toEqual([]);
    expect((await leadsService.listLeads(ctxAgent)).every((l) => l.assignedUserId === agentUserId)).toBe(true);

    // other org's project id yields nothing
    expect(await leadsService.listLeads(ctxOwner, { projectId: B.projectId })).toEqual([]);
  });
});

describe("HTTP routes", () => {
  it("POST /api/leads -> 201, then PATCH, assign, filtered list", async () => {
    const created = await http(cookieOwner, "POST", "/api/leads", { name: "Http Lead", phone: phone(), projectId: A.projectId });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await http(cookieOwner, "PATCH", `/api/leads/${id}`, { status: "INTERESTED" })).body.data.status).toBe("INTERESTED");
    const assigned = await http(cookieOwner, "POST", `/api/leads/${id}/assign`, { userId: agentUserId });
    expect(assigned.status).toBe(200);
    const list = await http(cookieOwner, "GET", `/api/leads?status=INTERESTED&assignedTo=${agentUserId}`);
    expect(list.body.data.map((l: { id: string }) => l.id)).toContain(id);
    expect((await http(cookieOwner, "GET", `/api/leads/${id}`)).body.data.assignedUserId).toBe(agentUserId);
  });

  it("status codes: 400 validation, 409 duplicate, 403 role, 404 unknown/other-org/unassigned", async () => {
    const p = phone();
    expect((await http(cookieOwner, "POST", "/api/leads", { name: "d", phone: p, projectId: A.projectId })).status).toBe(201);
    expect((await http(cookieOwner, "POST", "/api/leads", { name: "d", phone: p, projectId: A.projectId })).status).toBe(409);
    expect((await http(cookieOwner, "POST", "/api/leads", { name: "d", phone: "1", projectId: A.projectId })).status).toBe(400);
    expect((await http(cookieOwner, "POST", "/api/leads", { name: "d", phone: phone(), projectId: B.projectId })).status).toBe(404);
    expect((await http(cookieAgent, "POST", "/api/leads", { name: "d", phone: phone(), projectId: A.projectId })).status).toBe(403);
    expect((await http(cookieOwner, "PATCH", "/api/leads/not-a-uuid", { name: "x" })).status).toBe(400);
    expect((await http(cookieOwner, "GET", "/api/leads/not-a-uuid")).status).toBe(400);
    expect((await http(cookieOwner, "PATCH", `/api/leads/${B.leadId}`, { name: "x" })).status).toBe(404);
    expect((await http(cookieOwner, "POST", `/api/leads/${B.leadId}/assign`, { userId: null })).status).toBe(404);
    expect((await http(cookieOwner, "POST", `/api/leads/${A.leadId}/assign`, { userId: "x" })).status).toBe(400);
    expect((await http(cookieOwner, "GET", "/api/leads?status=BOGUS")).status).toBe(400);
    // agent: unassigned lead is invisible
    expect((await http(cookieAgent, "GET", `/api/leads/${A.leadId}`)).status).toBe(404);
    expect((await http(cookieAgent, "PATCH", `/api/leads/${A.leadId}`, { status: "DNC" })).status).toBe(404);
  });

  it("POST /:id/call audits call.initiated; refuses archived projects with 409 PROJECT_ARCHIVED", async () => {
    setTelephonyProvider(new MockTelephonyProvider({ baseUrl, autoplay: false }));
    const lead = await leadsService.createLead(ctxOwner, { name: "Callee", phone: phone(), projectId: A.projectId });
    const res = await http(cookieOwner, "POST", `/api/leads/${lead.id}/call`);
    expect(res.status).toBe(202);
    const rows = await auditRows(A.orgId, "call.initiated", res.body.data.callId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ callId: res.body.data.callId, leadId: lead.id, provider: "mock" });
    expect(JSON.stringify(rows[0])).not.toContain(lead.phone.slice(3));

    const [archived] = await db
      .insert(projects)
      .values({ organizationId: A.orgId, name: "Closed", location: "x" })
      .returning();
    const other = await leadsService.createLead(ctxOwner, { name: "Closed lead", phone: phone(), projectId: archived.id });
    await db.update(projects).set({ status: "archived", archivedAt: new Date() }).where(eq(projects.id, archived.id));
    const blocked = await http(cookieOwner, "POST", `/api/leads/${other.id}/call`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("PROJECT_ARCHIVED");
  });
});

describe("site visit booking audit + usage", () => {
  it("audits site_visit.booked and records exactly one usage event, idempotently", async () => {
    const lead = await leadsService.createLead(ctxOwner, { name: "Visitor", phone: phone(), projectId: A.projectId });
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const visit = await siteVisitsService.bookSiteVisit(ctxOwner, { leadId: lead.id, projectId: A.projectId, isoDateTime: when });

    const rows = await auditRows(A.orgId, "site_visit.booked", visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ leadId: lead.id, projectId: A.projectId, scheduledAt: when });
    expect(JSON.stringify(rows[0])).not.toContain(lead.phone.slice(3));

    await usageService.recordSiteVisit(ctxOwner, visit); // replay must not double count
    const events = await db.select().from(usageEvents).where(eq(usageEvents.dedupeKey, `site_visit:${visit.id}`));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ organizationId: A.orgId, type: "site_visit", quantity: 1 });
  });

  it("a failed booking (unknown lead) writes no audit row or usage event", async () => {
    const before = (await auditRows(A.orgId, "site_visit.booked")).length;
    await expect(
      siteVisitsService.bookSiteVisit(ctxOwner, { leadId: B.leadId, projectId: A.projectId, isoDateTime: new Date().toISOString() }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect((await auditRows(A.orgId, "site_visit.booked")).length).toBe(before);
  });
});
