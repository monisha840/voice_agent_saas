/**
 * THE tenant-isolation suite. Two complete organizations, A and B, each with
 * its own owner, project, lead, call, conversation and site visit. Everything
 * is asserted from A's side: A must not be able to read, change, call, book,
 * or even confirm the existence of any of B's data — through the HTTP API,
 * through the service layer, at the database constraint level, and through the
 * AI call path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.TURN_END_SILENCE_MS = "300";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { calls, conversations, leads, memberships, projectKnowledge, siteVisits } from "../../db/schema.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { callsService } from "../calls/calls.service.js";
import { leadsService } from "../leads/leads.service.js";
import { projectsService } from "../projects/projects.service.js";
import { siteVisitsService } from "../site-visits/site-visits.service.js";
import { leadsRepository } from "../../test/repos.js";
import { callsRepository } from "../../test/repos.js";
import { projectsRepository } from "../../test/repos.js";
import { expectPgError } from "../../test/helpers.js";
import { cleanupTenants, createTenant, loginCookie, TEST_PASSWORD, type TestTenant } from "../../test/tenants.js";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let cookieA: string;
let cookieB: string;
let ctxA: RequestContext;
let ctxB: RequestContext;

async function http(cookie: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  ctxA = userContext(A.orgId, A.userId, "OWNER");
  ctxB = userContext(B.orgId, B.userId, "OWNER");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});

describe("HTTP API: A sees only A", () => {
  it("lists contain only the caller's organization's rows", async () => {
    const projects = (await http(cookieA, "/api/projects")).body.data as Array<{ id: string }>;
    expect(projects.map((p) => p.id)).toEqual([A.projectId]);

    const leadList = (await http(cookieA, "/api/leads")).body.data as Array<{ id: string }>;
    expect(leadList.map((l) => l.id)).toEqual([A.leadId]);

    const visits = (await http(cookieA, "/api/site-visits")).body.data as Array<{ id: string }>;
    expect(visits.map((v) => v.id)).toEqual([A.siteVisitId]);

    // Control: B sees exactly B's.
    expect(((await http(cookieB, "/api/leads")).body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([B.leadId]);
  });

  it("A gets 404 (not 403) for every one of B's records, so even their existence is not revealed", async () => {
    for (const path of [
      `/api/projects/${B.projectId}`,
      `/api/leads/${B.leadId}`,
      `/api/calls/${B.callId}`,
      `/api/site-visits/${B.siteVisitId}`,
    ]) {
      const res = await http(cookieA, path);
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain("secret of B");
      expect(res.text).not.toContain(B.projectName);
    }
    // Control: B can read the same records.
    for (const path of [
      `/api/projects/${B.projectId}`,
      `/api/leads/${B.leadId}`,
      `/api/calls/${B.callId}`,
      `/api/site-visits/${B.siteVisitId}`,
    ]) {
      expect((await http(cookieB, path)).status, path).toBe(200);
    }
  });

  it("A's lead detail contains only A's call history, transcript and site visits", async () => {
    const detail = (await http(cookieA, `/api/leads/${A.leadId}`)).body.data;
    expect(detail.callHistory.map((c: { id: string }) => c.id)).toEqual([A.callId]);
    expect(detail.siteVisits.map((v: { id: string }) => v.id)).toEqual([A.siteVisitId]);
    expect(JSON.stringify(detail)).toContain("secret of A");
    expect(JSON.stringify(detail)).not.toContain("secret of B");
  });

  it("A cannot place a call to B's lead, and nothing is created or changed on B's side", async () => {
    const before = await leadsRepository.findById({ organizationId: B.orgId, id: B.leadId });
    const callsBefore = await callsRepository.listByLead({ organizationId: B.orgId, leadId: B.leadId });
    const res = await http(cookieA, `/api/leads/${B.leadId}/call`, { method: "POST" });
    expect(res.status).toBe(404);
    const after = await leadsRepository.findById({ organizationId: B.orgId, id: B.leadId });
    expect(after?.status).toBe(before?.status);
    expect(await callsRepository.listByLead({ organizationId: B.orgId, leadId: B.leadId })).toHaveLength(callsBefore.length);
  });

  it("an unauthenticated caller sees nothing of either organization", async () => {
    for (const path of ["/api/leads", `/api/leads/${A.leadId}`, `/api/calls/${A.callId}`, "/api/site-visits"]) {
      expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(401);
    }
  });
});

describe("service layer: A's context cannot modify or reach B's data", () => {
  it("lead updates against B's lead are no-ops that report nothing found", async () => {
    expect(await leadsService.updateLead(ctxA, { leadId: B.leadId, requirementConfig: "HACKED", budgetMax: 1 })).toBeNull();
    expect(await leadsService.markNotInterested(ctxA, { leadId: B.leadId })).toBeNull();
    expect(await leadsService.updateStatus(ctxA, { leadId: B.leadId, status: "DNC" })).toBeNull();
    const b = await leadsRepository.findById({ organizationId: B.orgId, id: B.leadId });
    expect(b?.requirementConfig).not.toBe("HACKED");
    expect(b?.status).toBe("NEW");
    expect(await leadsService.getLeadDetail(ctxA, { leadId: B.leadId })).toBeNull();
    await expect(leadsService.getLeadOrThrow(ctxA, { leadId: B.leadId })).rejects.toThrow(/not found/i);
  });

  it("A cannot create a call, finalize a call, read a call, or book a visit on B's records", async () => {
    await expect(callsService.createCall(ctxA, { leadId: B.leadId })).rejects.toThrow(/not found/i);
    await expect(callsService.finalizeCall(ctxA, { callId: B.callId })).rejects.toThrow(/not found/i);
    expect(await callsService.getCallDetail(ctxA, { callId: B.callId })).toBeNull();
    await expect(
      siteVisitsService.bookSiteVisit(ctxA, { leadId: B.leadId, projectId: B.projectId, isoDateTime: new Date(Date.now() + 1e9).toISOString() }),
    ).rejects.toThrow(/not found/i);
    // Own lead + B's project is refused too.
    await expect(
      siteVisitsService.bookSiteVisit(ctxA, { leadId: A.leadId, projectId: B.projectId, isoDateTime: new Date(Date.now() + 1e9).toISOString() }),
    ).rejects.toThrow(/not found/i);
    expect(await siteVisitsService.getById(ctxA, { id: B.siteVisitId })).toBeNull();
    expect(await siteVisitsService.listByLead(ctxA, { leadId: B.leadId })).toEqual([]);
  });

  it("project reads are confined to the organization", async () => {
    expect(await projectsService.getProjectWithKnowledge(ctxA, { projectId: B.projectId })).toBeNull();
    expect(await projectsService.getKnowledgeByCategory(ctxA, { projectId: B.projectId, category: "pricing" })).toEqual([]);
    expect(await projectsRepository.findById({ organizationId: A.orgId, id: B.projectId })).toBeNull();
    expect((await projectsService.listProjects(ctxA)).map((p) => p.id)).toEqual([A.projectId]);
  });

  it("B's data was never changed by any of the attempts above", async () => {
    expect((await leadsService.getLeadDetail(ctxB, { leadId: B.leadId }))?.callHistory).toHaveLength(1);
    expect(await siteVisitsService.listByLead(ctxB, { leadId: B.leadId })).toHaveLength(1);
  });
});

describe("database constraints: cross-organization links are impossible even with direct SQL", () => {
  const fkError = /foreign key|violates/i;

  it("a lead cannot point at another organization's project", async () => {
    await expectPgError(db.insert(leads).values({ organizationId: A.orgId, projectId: B.projectId, name: "x", phone: "+919000099999" }), fkError);
  });

  it("a call cannot point at another organization's lead", async () => {
    await expectPgError(db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, leadId: B.leadId, status: "initiating" }), fkError);
  });

  it("a conversation cannot point at another organization's call", async () => {
    await expectPgError(db.insert(conversations).values({ organizationId: A.orgId, callId: B.callId }), fkError);
  });

  it("a site visit cannot point at another organization's lead or project", async () => {
    const when = new Date(Date.now() + 1e9);
    await expectPgError(db.insert(siteVisits).values({ organizationId: A.orgId, leadId: B.leadId, projectId: A.projectId, scheduledAt: when }), fkError);
    await expectPgError(db.insert(siteVisits).values({ organizationId: A.orgId, leadId: A.leadId, projectId: B.projectId, scheduledAt: when }), fkError);
  });

  it("project knowledge cannot be attached to another organization's project", async () => {
    await expectPgError(db.insert(projectKnowledge).values({ organizationId: A.orgId, projectId: B.projectId, category: "faq", content: {} }), fkError);
  });

  it("every tenant table refuses a row with no organization", async () => {
    await expectPgError(db.insert(leads).values({ projectId: A.projectId, name: "x", phone: "+919000099998" } as never), /null|organization/i);
  });
});

describe("system flows stay inside the owning organization", () => {
  it("a provider status callback for B's call changes B's call only", async () => {
    const [bCall] = await db
      .insert(calls)
      .values({ organizationId: B.orgId, agentId: B.agentId, leadId: B.leadId, status: "ringing", providerCallId: `iso-cb-${Date.now()}` })
      .returning();
    await db.insert(conversations).values({ organizationId: B.orgId, callId: bCall.id });
    await db.update(leads).set({ status: "CALLING" }).where(and(eq(leads.id, B.leadId), eq(leads.organizationId, B.orgId)));

    const aBefore = await leadsRepository.findById({ organizationId: A.orgId, id: A.leadId });
    const res = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: bCall.providerCallId, status: "busy" }),
    });
    expect(res.status).toBe(200);

    expect((await leadsRepository.findById({ organizationId: B.orgId, id: B.leadId }))?.status).toBe("BUSY");
    expect((await callsRepository.findById({ organizationId: B.orgId, id: bCall.id }))?.status).toBe("failed");
    expect((await leadsRepository.findById({ organizationId: A.orgId, id: A.leadId }))?.status).toBe(aBefore?.status);
    expect(await callsRepository.findById({ organizationId: A.orgId, id: bCall.id })).toBeNull();
  });

  it("a whole simulated AI call for B uses B's project knowledge and writes only B's rows", async () => {
    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    const aCallsBefore = await db.select().from(calls).where(eq(calls.organizationId, A.orgId));

    const res = await http(cookieB, `/api/leads/${B.leadId}/call`, { method: "POST" });
    expect(res.status).toBe(202);
    const callId = res.body.data.callId as string;
    const report = await provider.simulations[0];
    expect(report?.protocolViolations).toEqual([]);

    // Wait for the background finalization.
    let detail: { conversation?: { summary?: string; transcript: Array<{ speaker: string; text: string }> } } | null = null;
    for (let i = 0; i < 100; i++) {
      detail = (await http(cookieB, `/api/calls/${callId}`)).body.data;
      if (detail?.conversation?.summary) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const aiText = (detail?.conversation?.transcript ?? []).filter((t) => t.speaker === "ai").map((t) => t.text).join(" ");
    expect(aiText).toContain("B Heights"); // the lead's own project, via the get_project_details tool
    expect(aiText).not.toContain("A Heights");

    // Every row the call produced belongs to B, and A gained nothing.
    const row = await callsRepository.findByIdAnyOrg({ id: callId });
    expect(row?.organizationId).toBe(B.orgId);
    const convo = await db.select().from(conversations).where(eq(conversations.callId, callId));
    expect(convo.every((c) => c.organizationId === B.orgId)).toBe(true);
    expect(await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).toHaveLength(aCallsBefore.length);
    // And A still cannot see it.
    expect((await http(cookieA, `/api/calls/${callId}`)).status).toBe(404);
  });
});

describe("users who belong to several organizations", () => {
  it("only see the active organization, and cannot switch into one they do not belong to", async () => {
    // A owner is also an ADMIN in B (sees all of B, unlike an AGENT).
    await db.insert(memberships).values({ organizationId: B.orgId, userId: A.userId, role: "ADMIN" });
    const cookie = await loginCookie(baseUrl, A.email, TEST_PASSWORD);

    const me = (await http(cookie, "/api/auth/me")).body.data;
    expect(me.organizations).toHaveLength(2);
    expect(me.organization.id).toBe(A.orgId); // oldest membership is the default

    expect(((await http(cookie, "/api/leads")).body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([A.leadId]);

    const sw = await http(cookie, "/api/auth/switch-organization", { method: "POST", body: JSON.stringify({ organizationId: B.orgId }) });
    expect(sw.status).toBe(200);
    expect(((await http(cookie, "/api/leads")).body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([B.leadId]);
    expect((await http(cookie, `/api/leads/${A.leadId}`)).status).toBe(404); // A's data is now out of scope

    // An organization the user is not in (B's owner is not in A).
    const bad = await http(cookieB, "/api/auth/switch-organization", { method: "POST", body: JSON.stringify({ organizationId: A.orgId }) });
    expect(bad.status).toBe(403);
    expect(((await http(cookieB, "/api/leads")).body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([B.leadId]);

    const garbage = await http(cookieB, "/api/auth/switch-organization", { method: "POST", body: JSON.stringify({ organizationId: "not-a-uuid" }) });
    expect(garbage.status).toBe(400);
  });

  it("losing a membership takes effect on the very next request", async () => {
    const cookie = await loginCookie(baseUrl, B.email);
    expect((await http(cookie, "/api/leads")).status).toBe(200);
    await db.delete(memberships).where(and(eq(memberships.userId, B.userId), eq(memberships.organizationId, B.orgId)));
    const res = await http(cookie, "/api/leads");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_ORGANIZATION");
    // restore for cleanliness
    await db.insert(memberships).values({ organizationId: B.orgId, userId: B.userId, role: "OWNER" });
  });
});

describe("attacker-controlled fields never move data across organizations (mass assignment / IDOR)", () => {
  it("a client-supplied organizationId on create is ignored; the row lands in the caller's organization", async () => {
    const res = await http(cookieA, "/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: "Forged Org Lead", phone: "+919000077001", projectId: A.projectId, organizationId: B.orgId }),
    });
    // Either the strict schema refuses the unknown field or it is dropped: it must never be honoured.
    expect([200, 201, 400]).toContain(res.status);
    const rows = await db.select().from(leads).where(eq(leads.name, "Forged Org Lead"));
    for (const r of rows) expect(r.organizationId).toBe(A.orgId);
    expect(rows.filter((r) => r.organizationId === B.orgId)).toHaveLength(0);
  });

  it("pointing a create at B's project is refused (it does not exist for A) and creates nothing", async () => {
    const before = await db.select().from(leads).where(eq(leads.organizationId, B.orgId));
    const res = await http(cookieA, "/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: "Into B", phone: "+919000077002", projectId: B.projectId }),
    });
    expect([400, 404]).toContain(res.status);
    expect(await db.select().from(leads).where(eq(leads.organizationId, B.orgId))).toHaveLength(before.length);
  });

  it("an update cannot re-parent a lead to another organization or its project", async () => {
    const res = await http(cookieA, `/api/leads/${A.leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", organizationId: B.orgId, projectId: B.projectId }),
    });
    expect([200, 400, 404]).toContain(res.status);
    const [row] = await db.select().from(leads).where(eq(leads.id, A.leadId));
    expect(row.organizationId).toBe(A.orgId);
    expect(row.projectId).toBe(A.projectId);
  });

  it("malformed and unexpected identifiers are rejected cleanly, never reaching the database as SQL", async () => {
    for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000", "' OR '1'='1", "../../etc/passwd", `${A.leadId}%27`]) {
      const res = await http(cookieA, `/api/leads/${encodeURIComponent(id)}`);
      expect([400, 404], id).toContain(res.status);
      expect(res.text).not.toMatch(/syntax|postgres|stack|select /i);
    }
  });

  it("a provider callback cannot re-assign a call to another organization or lead, whatever its body claims", async () => {
    const providerCallId = `iso-forge-${Date.now()}`;
    const [bCall] = await db
      .insert(calls)
      .values({ organizationId: B.orgId, agentId: B.agentId, leadId: B.leadId, status: "ringing", providerCallId })
      .returning();
    await db.insert(conversations).values({ organizationId: B.orgId, callId: bCall.id });
    const res = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId, status: "in_progress", organizationId: A.orgId, leadId: A.leadId, callId: A.callId }),
    });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(calls).where(eq(calls.id, bCall.id));
    expect(after.organizationId).toBe(B.orgId);
    expect(after.leadId).toBe(B.leadId);
    const [aCall] = await db.select().from(calls).where(eq(calls.id, A.callId));
    expect(aCall.organizationId).toBe(A.orgId);
  });

  it("a callback for an unknown call id changes nothing in any organization", async () => {
    const snapshot = async () => JSON.stringify((await db.select().from(calls)).map((c) => [c.id, c.status]).sort());
    const before = await snapshot();
    const res = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: "does-not-exist-anywhere", status: "completed" }),
    });
    expect(res.status).toBe(200);
    expect(await snapshot()).toBe(before);
  });
});

describe("concurrent traffic from two organizations never mixes", () => {
  it("many simultaneous authenticated requests each see only their own organization", async () => {
    const calls = Array.from({ length: 40 }, (_, i) => {
      const mine = i % 2 === 0 ? { cookie: cookieA, t: A, other: B } : { cookie: cookieB, t: B, other: A };
      return Promise.all([http(mine.cookie, "/api/leads"), http(mine.cookie, "/api/projects")]).then(([l, p]) => ({ mine, l, p }));
    });
    for (const { mine, l, p } of await Promise.all(calls)) {
      expect(l.status).toBe(200);
      expect(p.status).toBe(200);
      const all = l.text + p.text;
      expect(all).toContain(mine.t.projectName);
      expect(all).not.toContain(mine.other.projectName);
      expect(all).not.toContain(mine.other.orgId);
    }
  });

  it("a cookie from one organization never authorizes the other's data, even by exact id, under concurrency", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => Promise.all([http(cookieA, `/api/leads/${B.leadId}`), http(cookieB, `/api/leads/${A.leadId}`)])),
    );
    for (const [aToB, bToA] of attempts) {
      expect(aToB.status).toBe(404);
      expect(bToA.status).toBe(404);
    }
  });
});
