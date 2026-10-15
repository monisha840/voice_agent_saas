/**
 * Project management: create/edit/archive, knowledge CRUD, project members —
 * over HTTP for every role, plus tenant isolation, audit rows and the AI tool.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs, projectKnowledge, users } from "../../db/schema.js";
import { userContext } from "../../auth/context.js";
import { projectMembersRepository } from "../../test/repos.js";
import { projectsService } from "./projects.service.js";
import { executeTool } from "../../ai-tools/index.js";
import { demoContext } from "../../test/helpers.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const orgIds: string[] = [];

async function http(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function auditActions(orgId: string, entityId: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.entityId, entityId)));
  return rows;
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  orgIds.push(A.orgId, B.orgId);
  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const otherManager = await createMember(A.orgId, "MANAGER", "other-manager");
  const agent = await createMember(A.orgId, "AGENT");
  const outsider = await createMember(B.orgId, "AGENT", "outsider");
  ids.admin = admin.userId;
  ids.manager = manager.userId;
  ids.otherManager = otherManager.userId;
  ids.agent = agent.userId;
  ids.outsider = outsider.userId;

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies.owner = await loginCookie(baseUrl, A.email);
  cookies.admin = await loginCookie(baseUrl, admin.email);
  cookies.manager = await loginCookie(baseUrl, manager.email);
  cookies.agent = await loginCookie(baseUrl, agent.email);
  cookies.ownerB = await loginCookie(baseUrl, B.email);

  // The manager belongs to A's seeded project only after a second project exists; set up below.
  await projectMembersRepository.replaceForProject({ organizationId: A.orgId, projectId: A.projectId, userIds: [manager.userId] });
});

afterAll(async () => {
  await app.close();
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds));
  await cleanupTenants();
});

describe("create / update / archive", () => {
  it("OWNER creates a project and an audit row is written", async () => {
    const res = await http(cookies.owner, "POST", "/api/projects", { name: "  Lake View  ", location: "Pune", description: "Nice" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Lake View", location: "Pune", description: "Nice", status: "active", archivedAt: null });
    ids.lake = res.body.data.id;
    const actions = (await auditActions(A.orgId, ids.lake)).map((r) => r.action);
    expect(actions).toContain("project.created");
  });

  it("rejects bad input with 400 and an exact duplicate name with 409", async () => {
    expect((await http(cookies.owner, "POST", "/api/projects", { name: "x", location: "Pune" })).status).toBe(400);
    expect((await http(cookies.owner, "POST", "/api/projects", { location: "Pune" })).status).toBe(400);
    expect((await http(cookies.owner, "POST", "/api/projects", { name: "Lake View", location: "Pune" })).status).toBe(409);
  });

  it("the same name is allowed in another organization", async () => {
    const res = await http(cookies.ownerB, "POST", "/api/projects", { name: "Lake View", location: "Pune" });
    expect(res.status).toBe(201);
  });

  it("ADMIN can create; MANAGER and AGENT get 403", async () => {
    expect((await http(cookies.admin, "POST", "/api/projects", { name: "Admin Towers", location: "Delhi" })).status).toBe(201);
    expect((await http(cookies.manager, "POST", "/api/projects", { name: "Mgr Towers", location: "Delhi" })).status).toBe(403);
    expect((await http(cookies.agent, "POST", "/api/projects", { name: "Agent Towers", location: "Delhi" })).status).toBe(403);
  });

  it("PATCH updates fields, audits only the changed field names, and validates", async () => {
    const res = await http(cookies.owner, "PATCH", `/api/projects/${ids.lake}`, { location: "Mumbai" });
    expect(res.status).toBe(200);
    expect(res.body.data.location).toBe("Mumbai");
    const row = (await auditActions(A.orgId, ids.lake)).find((r) => r.action === "project.updated");
    expect(row?.metadata).toEqual({ changed: ["location"] });
    expect((await http(cookies.owner, "PATCH", `/api/projects/${ids.lake}`, {})).status).toBe(400);
    expect((await http(cookies.owner, "PATCH", `/api/projects/${ids.lake}`, { name: "Admin Towers" })).status).toBe(409);
  });

  it("MANAGER updates only projects they are a member of (404 otherwise); AGENT gets 403", async () => {
    const own = await http(cookies.manager, "PATCH", `/api/projects/${A.projectId}`, { description: "managed" });
    expect(own.status).toBe(200);
    expect(own.body.data.description).toBe("managed");
    expect((await http(cookies.manager, "PATCH", `/api/projects/${ids.lake}`, { description: "x" })).status).toBe(404);
    expect((await http(cookies.agent, "PATCH", `/api/projects/${A.projectId}`, { description: "x" })).status).toBe(403);
  });

  it("garbage ids give 400, unknown ids 404", async () => {
    expect((await http(cookies.owner, "GET", "/api/projects/not-a-uuid")).status).toBe(400);
    expect((await http(cookies.owner, "PATCH", "/api/projects/not-a-uuid", { name: "abc" })).status).toBe(400);
    expect((await http(cookies.owner, "GET", "/api/projects/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("archive hides from the default list, keeps it readable, and unarchive restores it", async () => {
    expect((await http(cookies.manager, "POST", `/api/projects/${ids.lake}/archive`)).status).toBe(403);
    const archived = await http(cookies.admin, "POST", `/api/projects/${ids.lake}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe("archived");
    expect(archived.body.data.archivedAt).toBeTruthy();

    const list = (await http(cookies.owner, "GET", "/api/projects")).body.data as Array<{ id: string }>;
    expect(list.map((p) => p.id)).not.toContain(ids.lake);
    const all = (await http(cookies.owner, "GET", "/api/projects?includeArchived=true")).body.data as Array<{ id: string }>;
    expect(all.map((p) => p.id)).toContain(ids.lake);
    expect((await http(cookies.owner, "GET", `/api/projects/${ids.lake}`)).status).toBe(200);

    // an archived name can be reused, which then blocks unarchiving the old one
    expect((await http(cookies.owner, "POST", "/api/projects", { name: "Lake View", location: "Pune" })).status).toBe(201);
    expect((await http(cookies.owner, "POST", `/api/projects/${ids.lake}/unarchive`)).status).toBe(409);
  });

  it("unarchive restores status and clears archivedAt; both transitions are audited", async () => {
    const p = await http(cookies.owner, "PATCH", `/api/projects/${ids.lake}`, { name: "Lake View Phase 1" });
    expect(p.status).toBe(200);
    const res = await http(cookies.owner, "POST", `/api/projects/${ids.lake}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "active", archivedAt: null });
    const actions = (await auditActions(A.orgId, ids.lake)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["project.archived", "project.unarchived"]));
  });

  it("getDefaultProject prefers an active project over an older archived one", async () => {
    const t = await createTenant("D");
    orgIds.push(t.orgId);
    const ctx = userContext(t.orgId, t.userId, "OWNER");
    await projectsService.archiveProject(ctx, { projectId: t.projectId });
    const fresh = await projectsService.createProject(ctx, { name: "Newer", location: "X" });
    expect((await projectsService.getDefaultProject(ctx)).id).toBe(fresh.id);
    await projectsService.archiveProject(ctx, { projectId: fresh.id });
    expect((await projectsService.getDefaultProject(ctx)).id).toBe(t.projectId);
  });
});

describe("knowledge", () => {
  it("upsert validates content and is idempotent per category", async () => {
    const put = (content: unknown, category = "rera") => http(cookies.owner, "PUT", `/api/projects/${A.projectId}/knowledge/${category}`, { content });
    const first = await put({ registrationNumber: "R-1", authority: "K-RERA" });
    expect(first.status).toBe(200);
    expect(first.body.data.category).toBe("rera");
    const second = await put({ registrationNumber: "R-2" });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await db
      .select()
      .from(projectKnowledge)
      .where(and(eq(projectKnowledge.projectId, A.projectId), eq(projectKnowledge.category, "rera")));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toEqual({ registrationNumber: "R-2" });

    const audit = (await auditActions(A.orgId, A.projectId)).filter((r) => r.action === "project.knowledge_updated");
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit[0].metadata).toEqual({ category: "rera" });
  });

  it("rejects unknown categories and bad content with 400 naming the field", async () => {
    const url = `/api/projects/${A.projectId}/knowledge`;
    expect((await http(cookies.owner, "PUT", `${url}/secrets`, { content: {} })).status).toBe(400);
    const bad = await http(cookies.owner, "PUT", `${url}/pricing`, { content: { ranges: [{ type: "2 BHK", min: 9, max: 1 }] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("ranges.0.max");
    expect((await http(cookies.owner, "PUT", `${url}/pricing`, {})).status).toBe(400);
    expect((await http(cookies.owner, "PUT", `${url}/pricing`, { content: "text" })).status).toBe(400);
    expect((await http(cookies.owner, "PUT", `${url}/booking`, { content: { bookingAmount: -1 } })).status).toBe(400);
  });

  it("MANAGER edits knowledge only of their projects; AGENT gets 403", async () => {
    const content = { assistanceAvailable: true };
    expect((await http(cookies.manager, "PUT", `/api/projects/${A.projectId}/knowledge/loan`, { content })).status).toBe(200);
    expect((await http(cookies.manager, "PUT", `/api/projects/${ids.lake}/knowledge/loan`, { content })).status).toBe(404);
    expect((await http(cookies.agent, "PUT", `/api/projects/${A.projectId}/knowledge/loan`, { content })).status).toBe(403);
    expect((await http(cookies.agent, "DELETE", `/api/projects/${A.projectId}/knowledge/loan`)).status).toBe(403);
  });

  it("delete removes the row, audits it, and a second delete is 404", async () => {
    const url = `/api/projects/${A.projectId}/knowledge/loan`;
    expect((await http(cookies.owner, "DELETE", url)).status).toBe(204);
    expect((await http(cookies.owner, "DELETE", url)).status).toBe(404);
    const actions = (await auditActions(A.orgId, A.projectId)).map((r) => r.action);
    expect(actions).toContain("project.knowledge_deleted");
    const detail = await http(cookies.owner, "GET", `/api/projects/${A.projectId}`);
    const cats = (detail.body.data.knowledge as Array<{ category: string }>).map((k) => k.category);
    expect(cats).toContain("rera");
    expect(cats).not.toContain("loan");
  });

  it("AGENT can read scoped project detail but not an unscoped one", async () => {
    expect((await http(cookies.agent, "GET", `/api/projects/${A.projectId}`)).status).toBe(404);
    await projectMembersRepository.replaceForProject({ organizationId: A.orgId, projectId: A.projectId, userIds: [ids.manager, ids.agent] });
    expect((await http(cookies.agent, "GET", `/api/projects/${A.projectId}`)).status).toBe(200);
    await projectMembersRepository.replaceForProject({ organizationId: A.orgId, projectId: A.projectId, userIds: [ids.manager] });
  });
});

describe("members", () => {
  it("OWNER/ADMIN set and read members; audit records the count", async () => {
    const put = await http(cookies.owner, "PUT", `/api/projects/${ids.lake}/members`, { userIds: [ids.manager, ids.agent, ids.manager] });
    expect(put.status).toBe(200);
    expect(put.body.data.map((m: { userId: string }) => m.userId).sort()).toEqual([ids.manager, ids.agent].sort());
    const get = await http(cookies.admin, "GET", `/api/projects/${ids.lake}/members`);
    expect(get.body.data).toHaveLength(2);
    const row = (await auditActions(A.orgId, ids.lake)).find((r) => r.action === "project.members_updated");
    expect(row?.metadata).toEqual({ count: 2 });
    // replace, not append
    const replaced = await http(cookies.admin, "PUT", `/api/projects/${ids.lake}/members`, { userIds: [] });
    expect(replaced.body.data).toEqual([]);
  });

  it("MANAGER and AGENT get 403 on members", async () => {
    expect((await http(cookies.manager, "PUT", `/api/projects/${A.projectId}/members`, { userIds: [] })).status).toBe(403);
    expect((await http(cookies.manager, "GET", `/api/projects/${A.projectId}/members`)).status).toBe(403);
    expect((await http(cookies.agent, "PUT", `/api/projects/${A.projectId}/members`, { userIds: [] })).status).toBe(403);
  });

  it("rejects users from another organization, unknown users, inactive users and bad bodies (400), leaving members untouched", async () => {
    const before = await http(cookies.owner, "GET", `/api/projects/${A.projectId}/members`);
    expect((await http(cookies.owner, "PUT", `/api/projects/${A.projectId}/members`, { userIds: [ids.outsider] })).status).toBe(400);
    expect((await http(cookies.owner, "PUT", `/api/projects/${A.projectId}/members`, { userIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await http(cookies.owner, "PUT", `/api/projects/${A.projectId}/members`, { userIds: ["nope"] })).status).toBe(400);
    expect((await http(cookies.owner, "PUT", `/api/projects/${A.projectId}/members`, {})).status).toBe(400);

    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.otherManager));
    expect((await http(cookies.owner, "PUT", `/api/projects/${A.projectId}/members`, { userIds: [ids.otherManager] })).status).toBe(400);
    await db.update(users).set({ isActive: true }).where(eq(users.id, ids.otherManager));

    const after = await http(cookies.owner, "GET", `/api/projects/${A.projectId}/members`);
    expect(after.body.data).toEqual(before.body.data);
  });
});

describe("tenant isolation", () => {
  it("org A cannot see, update, archive, edit knowledge of or set members on org B's project (404)", async () => {
    const p = `/api/projects/${B.projectId}`;
    expect((await http(cookies.owner, "GET", p)).status).toBe(404);
    expect((await http(cookies.owner, "PATCH", p, { name: "Hijacked" })).status).toBe(404);
    expect((await http(cookies.owner, "POST", `${p}/archive`)).status).toBe(404);
    expect((await http(cookies.owner, "PUT", `${p}/knowledge/rera`, { content: { registrationNumber: "X" } })).status).toBe(404);
    expect((await http(cookies.owner, "DELETE", `${p}/knowledge/pricing`)).status).toBe(404);
    expect((await http(cookies.owner, "GET", `${p}/members`)).status).toBe(404);
    expect((await http(cookies.owner, "PUT", `${p}/members`, { userIds: [] })).status).toBe(404);

    const [pricing] = await db
      .select()
      .from(projectKnowledge)
      .where(and(eq(projectKnowledge.projectId, B.projectId), eq(projectKnowledge.category, "pricing")));
    expect(pricing).toBeTruthy();
    expect((await http(cookies.ownerB, "GET", p)).body.data.status).toBe("active");
  });
});

describe("AI tool get_project_details", () => {
  it("returns the new structured categories for the seeded demo project", async () => {
    const org = await demoContext();
    const project = await projectsService.getDefaultProject(org);
    const result = (await executeTool(
      "get_project_details",
      {},
      { organizationId: org.organizationId, subject: { leadId: "00000000-0000-4000-8000-000000000000", projectId: project.id }, callId: "00000000-0000-4000-8000-000000000000" },
    )) as Record<string, unknown>;
    expect(result.faq).toBeTruthy();
    expect(result.rera).toMatchObject({ registrationNumber: expect.any(String) });
    expect(result.loan).toMatchObject({ assistanceAvailable: true });
    expect(result.booking).toMatchObject({ bookingAmount: 200000, currency: "INR" });
    expect(result.maintenance).toMatchObject({ chargesPerSqftPerMonth: 3.5 });
  });
});
