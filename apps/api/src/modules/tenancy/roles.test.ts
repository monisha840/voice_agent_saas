/**
 * API-level role enforcement on the existing endpoints. One organization with
 * two projects (P1, P2), each with a lead/call/visit, plus an owner, admin,
 * manager (member of P1 only) and agent (assigned only the lead in P2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { auditLogs, calls, leads, projectMembers, projects, siteVisits } from "../../db/schema.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let T: TestTenant;
let p2Id: string;
let lead2Id: string;
let call2Id: string;
let visit2Id: string;
const cookies = {} as Record<"OWNER" | "ADMIN" | "MANAGER" | "AGENT", string>;

async function http(role: keyof typeof cookies, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie: cookies[role], ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ids = (res: { body: { data: Array<{ id: string }> } }) => res.body.data.map((r) => r.id).sort();

beforeAll(async () => {
  T = await createTenant("A");
  const [p2] = await db.insert(projects).values({ organizationId: T.orgId, name: "A Towers", location: "A City" }).returning();
  p2Id = p2.id;
  const [l2] = await db
    .insert(leads)
    .values({ organizationId: T.orgId, projectId: p2Id, name: "A Lead 2", phone: "+919000010003" })
    .returning();
  lead2Id = l2.id;
  const [c2] = await db.insert(calls).values({ organizationId: T.orgId, agentId: T.agentId, leadId: lead2Id, status: "completed", providerCallId: `roles-${Date.now()}` }).returning();
  call2Id = c2.id;
  const [v2] = await db
    .insert(siteVisits)
    .values({ organizationId: T.orgId, leadId: lead2Id, projectId: p2Id, scheduledAt: new Date(Date.now() + 86_400_000) })
    .returning();
  visit2Id = v2.id;

  const admin = await createMember(T.orgId, "ADMIN");
  const manager = await createMember(T.orgId, "MANAGER");
  const agent = await createMember(T.orgId, "AGENT");
  await db.insert(projectMembers).values({ organizationId: T.orgId, projectId: T.projectId, userId: manager.userId });
  await db.update(leads).set({ assignedUserId: agent.userId }).where(eq(leads.id, lead2Id));

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies.OWNER = await loginCookie(baseUrl, T.email);
  cookies.ADMIN = await loginCookie(baseUrl, admin.email);
  cookies.MANAGER = await loginCookie(baseUrl, manager.email);
  cookies.AGENT = await loginCookie(baseUrl, agent.email);
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await db.delete(projectMembers).where(eq(projectMembers.organizationId, T.orgId));
  await db.delete(siteVisits).where(eq(siteVisits.organizationId, T.orgId));
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, T.orgId));
  await cleanupTenants();
});

describe("OWNER and ADMIN see the whole organization", () => {
  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`${role}: all leads, projects and visits; any record by id`, async () => {
      expect(ids(await http(role, "/api/leads"))).toEqual([T.leadId, lead2Id].sort());
      expect(ids(await http(role, "/api/projects"))).toEqual([T.projectId, p2Id].sort());
      expect(ids(await http(role, "/api/site-visits"))).toEqual([T.siteVisitId, visit2Id].sort());
      for (const path of [`/api/leads/${lead2Id}`, `/api/projects/${p2Id}`, `/api/calls/${call2Id}`, `/api/site-visits/${visit2Id}`]) {
        expect((await http(role, path)).status).toBe(200);
      }
    });
  }
});

describe("MANAGER sees only the projects they are a member of", () => {
  it("lists contain only P1's records", async () => {
    expect(ids(await http("MANAGER", "/api/leads"))).toEqual([T.leadId]);
    expect(ids(await http("MANAGER", "/api/projects"))).toEqual([T.projectId]);
    expect(ids(await http("MANAGER", "/api/site-visits"))).toEqual([T.siteVisitId]);
  });

  it("in-scope records are readable, out-of-scope ones are 404 (not 403)", async () => {
    for (const path of [`/api/leads/${T.leadId}`, `/api/projects/${T.projectId}`, `/api/calls/${T.callId}`, `/api/site-visits/${T.siteVisitId}`]) {
      expect((await http("MANAGER", path)).status).toBe(200);
    }
    for (const path of [`/api/leads/${lead2Id}`, `/api/projects/${p2Id}`, `/api/calls/${call2Id}`, `/api/site-visits/${visit2Id}`]) {
      expect((await http("MANAGER", path)).status).toBe(404);
    }
  });

  it("a manager with no project memberships sees nothing", async () => {
    const lonely = await createMember(T.orgId, "MANAGER", "lonely");
    const cookie = await loginCookie(baseUrl, lonely.email);
    const empty = async (path: string) => ((await (await fetch(`${baseUrl}${path}`, { headers: { cookie } })).json()) as { data: unknown[] }).data;
    expect(await empty("/api/leads")).toEqual([]);
    expect(await empty("/api/projects")).toEqual([]);
  });
});

describe("AGENT sees only leads assigned to them", () => {
  it("lists contain only the assigned lead, its project and its visits", async () => {
    expect(ids(await http("AGENT", "/api/leads"))).toEqual([lead2Id]);
    expect(ids(await http("AGENT", "/api/projects"))).toEqual([p2Id]);
    expect(ids(await http("AGENT", "/api/site-visits"))).toEqual([visit2Id]);
  });

  it("assigned records readable; unassigned lead/call/visit/project are 404", async () => {
    for (const path of [`/api/leads/${lead2Id}`, `/api/projects/${p2Id}`, `/api/calls/${call2Id}`, `/api/site-visits/${visit2Id}`]) {
      expect((await http("AGENT", path)).status).toBe(200);
    }
    for (const path of [`/api/leads/${T.leadId}`, `/api/projects/${T.projectId}`, `/api/calls/${T.callId}`, `/api/site-visits/${T.siteVisitId}`]) {
      expect((await http("AGENT", path)).status).toBe(404);
    }
  });

  it("cannot place a call on an unassigned lead (404) but can on an assigned one", async () => {
    setTelephonyProvider(new MockTelephonyProvider({ baseUrl, autoplay: false }));
    const denied = await http("AGENT", `/api/leads/${T.leadId}/call`, { method: "POST" });
    expect(denied.status).toBe(404);
    const allowed = await http("AGENT", `/api/leads/${lead2Id}/call`, { method: "POST" });
    expect(allowed.status).toBe(202);
  });

  it("a manager cannot call a lead outside their projects either", async () => {
    expect((await http("MANAGER", `/api/leads/${lead2Id}/call`, { method: "POST" })).status).toBe(404);
  });
});

describe("team and organization endpoints per role", () => {
  it("GET /api/users: OWNER/ADMIN/MANAGER allowed, AGENT 403", async () => {
    expect((await http("OWNER", "/api/users")).status).toBe(200);
    expect((await http("ADMIN", "/api/users")).status).toBe(200);
    expect((await http("MANAGER", "/api/users")).status).toBe(200);
    expect((await http("AGENT", "/api/users")).status).toBe(403);
  });

  it("GET /api/organization is readable by all four roles and reports the caller's role", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "AGENT"] as const) {
      const res = await http(role, "/api/organization");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: T.orgId, role });
    }
  });

  it("PATCH /api/organization is OWNER only", async () => {
    for (const role of ["ADMIN", "MANAGER", "AGENT"] as const) {
      const res = await http(role, "/api/organization", { method: "PATCH", body: JSON.stringify({ name: "Hijacked" }) });
      expect(res.status).toBe(403);
    }
    expect((await http("OWNER", "/api/organization")).body.data.name).not.toBe("Hijacked");
    const ok = await http("OWNER", "/api/organization", { method: "PATCH", body: JSON.stringify({ name: "Renamed Org" }) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe("Renamed Org");
  });

  it("team-management endpoints deny MANAGER and AGENT", async () => {
    for (const role of ["MANAGER", "AGENT"] as const) {
      expect((await http(role, "/api/users/invitations")).status).toBe(403);
      const inv = await http(role, "/api/users/invitations", { method: "POST", body: JSON.stringify({ email: "x@example.test", role: "AGENT" }) });
      expect(inv.status).toBe(403);
    }
  });
});
