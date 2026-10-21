/**
 * Customer dashboard MVP endpoints: call stats and filters (core), the Sales overview, lead search and paging, and
 * site-visit create / reschedule / cancel. Focus: tenant isolation, role scope, invalid transitions, duplicates.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { calls, leads, siteVisits } from "../../db/schema.js";
import { httpClient, relaxRateLimits } from "../../test/agent-first.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

describe("customer dashboard MVP", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let http: ReturnType<typeof httpClient>;
  let A: TestTenant;
  let B: TestTenant;
  let off: TestTenant;
  const cookie: Record<string, string> = {};

  beforeAll(async () => {
    relaxRateLimits();
    A = await createTenant("DashA");
    B = await createTenant("DashB");
    off = await createTenant("DashOff", { modules: [] });
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    http = httpClient(baseUrl);
    cookie.A = await loginCookie(baseUrl, A.email);
    cookie.B = await loginCookie(baseUrl, B.email);
    cookie.off = await loginCookie(baseUrl, off.email);
    cookie.agentA = await loginCookie(baseUrl, (await createMember(A.orgId, "AGENT")).email);
    // A: one more call that connected; B: two extra calls (must never show up for A).
    await db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, leadId: A.leadId, status: "completed", startedAt: new Date(Date.now() - 120_000), endedAt: new Date(Date.now() - 60_000) });
    for (let i = 0; i < 2; i++) await db.insert(calls).values({ organizationId: B.orgId, agentId: B.agentId, status: "completed", startedAt: new Date() });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await cleanupTenants();
  });

  describe("call stats and filters (core)", () => {
    it("counts only the caller's organization, with a filled per-day series", async () => {
      const res = await http(cookie.A, "GET", "/api/calls/stats?days=7");
      expect(res.status).toBe(200);
      const s = res.body.data;
      expect(s.total).toBe(2);
      expect(s.answered).toBe(1);
      expect(s.completed).toBe(2);
      expect(s.talkSeconds).toBeGreaterThanOrEqual(59);
      expect(s.daily).toHaveLength(7);
      expect(s.daily.reduce((n: number, d: { total: number }) => n + d.total, 0)).toBe(2);
      expect((await http(cookie.B, "GET", "/api/calls/stats?days=7")).body.data.total).toBe(3);
    });

    it("a restricted role only counts calls it may list", async () => {
      expect((await http(cookie.agentA, "GET", "/api/calls/stats")).body.data.total).toBe(0);
    });

    it("validates the window", async () => {
      expect((await http(cookie.A, "GET", "/api/calls/stats?days=0")).status).toBe(400);
      expect((await http(cookie.A, "GET", "/api/calls/stats?days=365")).status).toBe(400);
    });

    it("filters calls by outcome and date", async () => {
      const answered = await http(cookie.A, "GET", "/api/calls?outcome=answered");
      expect(answered.body.data).toHaveLength(1);
      expect(answered.body.data[0].startedAt).not.toBeNull();
      expect((await http(cookie.A, "GET", "/api/calls?outcome=unanswered")).body.data).toHaveLength(1);
      expect((await http(cookie.A, "GET", `/api/calls?from=${encodeURIComponent(future(1))}`)).body.data).toHaveLength(0);
      expect((await http(cookie.A, "GET", `/api/calls?to=${encodeURIComponent(future(1))}`)).body.data).toHaveLength(2);
      expect((await http(cookie.A, "GET", "/api/calls?outcome=booked")).status).toBe(400);
    });
  });

  describe("sales overview", () => {
    it("returns the tenant's own lead totals, newest leads and upcoming visits", async () => {
      const res = await http(cookie.A, "GET", "/api/sales/overview?days=14");
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.leads.total).toBe(1);
      expect(d.leads.daily).toHaveLength(14);
      expect(d.recentLeads.map((l: { id: string }) => l.id)).toEqual([A.leadId]);
      expect(d.upcomingVisits.total).toBe(1);
      expect(d.upcomingVisits.data[0]).toMatchObject({ id: A.siteVisitId, leadName: "DashA Lead", projectName: A.projectName });
      expect(JSON.stringify(d)).not.toContain(B.leadId);
    });

    it("an agent with no assigned leads sees nothing of the organization's leads", async () => {
      const d = (await http(cookie.agentA, "GET", "/api/sales/overview")).body.data;
      expect(d.leads.total).toBe(0);
      expect(d.recentLeads).toEqual([]);
      expect(d.upcomingVisits.total).toBe(0);
    });

    it("is refused when the Sales module is off", async () => {
      expect((await http(cookie.off, "GET", "/api/sales/overview")).status).toBe(403);
    });
  });

  describe("lead search and paging", () => {
    beforeAll(async () => {
      for (const [name, phone] of [["Priya Raman", "+919811100001"], ["Arun 100%", "+919811100002"], ["Priyanka S", "+919811100003"]]) {
        await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name, phone });
      }
    });

    it("searches by name and by phone digits, within the tenant only", async () => {
      const byName = await http(cookie.A, "GET", "/api/leads?q=priya&limit=10");
      expect(byName.body.total).toBe(2);
      expect(byName.body.data.map((l: { name: string }) => l.name).sort()).toEqual(["Priya Raman", "Priyanka S"]);
      expect((await http(cookie.A, "GET", "/api/leads?q=98111%2000002&limit=10")).body.data.map((l: { name: string }) => l.name)).toEqual(["Arun 100%"]);
      // LIKE wildcards are literal: "%" matches only the lead whose name contains it.
      expect((await http(cookie.A, "GET", "/api/leads?q=%25&limit=10")).body.total).toBe(1);
      expect((await http(cookie.A, "GET", "/api/leads?q=DashB&limit=10")).body.total).toBe(0);
    });

    it("pages with a stable total and validates the paging parameters", async () => {
      const p1 = await http(cookie.A, "GET", "/api/leads?limit=2&offset=0");
      const p2 = await http(cookie.A, "GET", "/api/leads?limit=2&offset=2");
      expect(p1.body.total).toBe(4);
      expect(p1.body.data).toHaveLength(2);
      expect(p2.body.data).toHaveLength(2);
      const ids = [...p1.body.data, ...p2.body.data].map((l: { id: string }) => l.id);
      expect(new Set(ids).size).toBe(4);
      expect((await http(cookie.A, "GET", "/api/leads?limit=1000")).status).toBe(400);
      // Without paging parameters the full list is returned, as before.
      expect((await http(cookie.A, "GET", "/api/leads")).body.data).toHaveLength(4);
    });
  });

  describe("site visits", () => {
    it("refuses a second upcoming visit for the same lead", async () => {
      const res = await http(cookie.A, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: future(3) });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has a site visit/);
    });

    it("cancels an upcoming visit once; a cancelled visit cannot be cancelled or moved", async () => {
      const first = await http(cookie.A, "POST", `/api/site-visits/${A.siteVisitId}/cancel`);
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("cancelled");
      expect((await http(cookie.A, "POST", `/api/site-visits/${A.siteVisitId}/cancel`)).status).toBe(409);
      expect((await http(cookie.A, "POST", `/api/site-visits/${A.siteVisitId}/reschedule`, { scheduledAt: future(4) })).status).toBe(409);
    });

    it("books for the lead's own project, moves the lead to VISIT_BOOKED, and validates the time", async () => {
      expect((await http(cookie.A, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
      expect((await http(cookie.A, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: future(400) })).status).toBe(400);
      // The browser cannot choose the organization or project.
      expect((await http(cookie.A, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: future(2), projectId: B.projectId })).status).toBe(400);
      const res = await http(cookie.A, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: future(2) });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ leadId: A.leadId, projectId: A.projectId, status: "booked" });
      const [lead] = await db.select().from(leads).where(eq(leads.id, A.leadId));
      expect(lead.status).toBe("VISIT_BOOKED");

      const moved = await http(cookie.A, "POST", `/api/site-visits/${res.body.data.id}/reschedule`, { scheduledAt: future(5) });
      expect(moved.status).toBe(200);
      expect(new Date(moved.body.data.scheduledAt).getTime()).toBeGreaterThan(Date.now() + 4 * DAY);
    });

    it("a past visit cannot be changed", async () => {
      const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Past Visitor", phone: "+919811100009" }).returning();
      const [past] = await db.insert(siteVisits).values({ organizationId: A.orgId, leadId: lead.id, projectId: A.projectId, scheduledAt: new Date(Date.now() - DAY) }).returning();
      const res = await http(cookie.A, "POST", `/api/site-visits/${past.id}/cancel`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/time has passed/);
      const views = async (view: string) => (await http(cookie.A, "GET", `/api/site-visits?view=${view}&limit=50`)).body;
      expect((await views("past")).data.map((v: { id: string }) => v.id)).toContain(past.id);
      expect((await views("upcoming")).data.map((v: { id: string }) => v.id)).not.toContain(past.id);
      expect((await views("cancelled")).data.map((v: { id: string }) => v.id)).toContain(A.siteVisitId);
    });

    it("concurrent bookings for one lead admit exactly one", async () => {
      const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Race Lead", phone: "+919811100010" }).returning();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => http(cookie.A, "POST", "/api/site-visits", { leadId: lead.id, scheduledAt: future(2 + i) })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      const rows = await db.select().from(siteVisits).where(eq(siteVisits.leadId, lead.id));
      expect(rows).toHaveLength(1);
    });

    it("another tenant's visits and leads behave as not found", async () => {
      expect((await http(cookie.A, "POST", `/api/site-visits/${B.siteVisitId}/cancel`)).status).toBe(404);
      expect((await http(cookie.A, "POST", `/api/site-visits/${B.siteVisitId}/reschedule`, { scheduledAt: future(3) })).status).toBe(404);
      expect((await http(cookie.A, "POST", "/api/site-visits", { leadId: B.leadId, scheduledAt: future(3) })).status).toBe(404);
      const [visit] = await db.select().from(siteVisits).where(eq(siteVisits.id, B.siteVisitId));
      expect(visit.status).toBe("booked");
      const list = await http(cookie.A, "GET", "/api/site-visits?view=all&limit=100");
      expect(list.body.data.some((v: { leadId: string }) => v.leadId === B.leadId)).toBe(false);
    });

    it("an agent cannot act on visits of leads outside their scope", async () => {
      expect((await http(cookie.agentA, "POST", `/api/site-visits/${B.siteVisitId}/cancel`)).status).toBe(404);
      const upcoming = (await http(cookie.A, "GET", "/api/site-visits?view=upcoming&limit=1")).body.data[0];
      expect((await http(cookie.agentA, "POST", `/api/site-visits/${upcoming.id}/cancel`)).status).toBe(404);
      expect((await http(cookie.agentA, "POST", "/api/site-visits", { leadId: A.leadId, scheduledAt: future(3) })).status).toBe(404);
    });
  });
});
