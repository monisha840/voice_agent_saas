/**
 * Integration audit of billing against the live call lifecycle, seat caps and concurrency (real PostgreSQL, restricted
 * runtime role). Complements billing.test.ts (ledger, quotas, payments) and billing-pure.test.ts (rules).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql } from "../../db/client.js";
import { agents, auditLogs, billingEvents, calls, invitations, subscriptions, usageLedger } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { cleanupTenants, createDefaultAgent, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { callsService } from "../calls/calls.service.js";
import { subscriptionsRepository } from "../../db/repositories/billing.repository.js";
import { evaluateEntitlements } from "./entitlements-engine.js";
import { paymentEventsService } from "./payment-events.service.js";
import { createMockPaymentProvider } from "./payment-provider.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let M: TestTenant; // managed, lifecycle + periods
let S: TestTenant; // managed, seat caps
let T: TestTenant; // second managed tenant with the same caps (isolation)
let U: TestTenant; // unmanaged
let cookieS = "";
let cookieT = "";
let cookieU = "";
let agentM = "";

const day = 86_400_000;
const orgIds = () => [M.orgId, S.orgId, T.orgId, U.orgId];
const sys = (t: TestTenant) => systemContext(t.orgId, "test");

async function http(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function sub(t: TestTenant, v: Partial<typeof subscriptions.$inferInsert> & { planKey: string }) {
  const now = Date.now();
  await db.insert(subscriptions).values({
    organizationId: t.orgId,
    status: "active",
    currentPeriodStart: new Date(now - 5 * day),
    currentPeriodEnd: new Date(now + 25 * day),
    ...v,
  });
}

const ledgerFor = (callId: string) => db.select().from(usageLedger).where(eq(usageLedger.callId, callId));
const activeAgents = async (t: TestTenant) =>
  (await db.select().from(agents).where(and(eq(agents.organizationId, t.orgId), eq(agents.status, "active")))).length;

beforeAll(async () => {
  M = await createTenant("AUD_M", { modules: [] });
  S = await createTenant("AUD_S", { modules: [] });
  T = await createTenant("AUD_T", { modules: [] });
  U = await createTenant("AUD_U", { modules: [] });
  agentM = (await createDefaultAgent(M.orgId, { name: "M2", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })).id;
  await sub(M, { planKey: "starter", limitOverrides: { includedMinutes: 100_000, maxConcurrentCalls: 50 } });
  ({ app, baseUrl } = await startTestApp());
  cookieS = await loginCookie(baseUrl, S.email);
  cookieT = await loginCookie(baseUrl, T.email);
  cookieU = await loginCookie(baseUrl, U.email);
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
  process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
  process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await adminSql!.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe("delete from usage_ledger where organization_id = any($1::uuid[])", [orgIds()]);
  });
  await db.delete(billingEvents).where(inArray(billingEvents.organizationId, orgIds()));
  await db.delete(invitations).where(inArray(invitations.organizationId, orgIds()));
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds()));
  await db.delete(subscriptions).where(inArray(subscriptions.organizationId, orgIds()));
  await cleanupTenants();
});

afterEach(() => vi.restoreAllMocks());

describe("metering is driven by the call lifecycle, not by a later read", () => {
  it("a completed call is in the ledger the moment it ends, with no reconcile and no summary", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: M.orgId, agentId: agentM, status: "in_progress", callType: "outbound", startedAt: new Date(Date.now() - 95_000) })
      .returning();
    expect(await ledgerFor(call.id)).toHaveLength(0);
    await callsService.endFromStream({ callId: call.id, outcome: "completed" });
    const rows = await ledgerFor(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "call_lifecycle", state: "final", billableReason: "billed", billableSeconds: 120 });
  });

  it("repeated terminal signals (stream end, provider callback, retries) never add a second charge", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: M.orgId, agentId: agentM, status: "in_progress", callType: "outbound", startedAt: new Date(Date.now() - 70_000), providerCallId: `prov-${Date.now()}` })
      .returning();
    await Promise.all([
      callsService.endFromStream({ callId: call.id, outcome: "completed" }),
      callsService.endFromStream({ callId: call.id, outcome: "completed" }),
      callsService.updateStatusFromProvider({ providerCallId: call.providerCallId!, status: "completed" }),
      callsService.updateStatusFromProvider({ providerCallId: call.providerCallId!, status: "completed" }),
    ]);
    await callsService.endFromStream({ callId: call.id, outcome: "completed" });
    const rows = await ledgerFor(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].billableSeconds).toBe(120);
  });

  it("a call that failed or was never answered is recorded as zero (explicit policy, no silent gap)", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: M.orgId, agentId: agentM, status: "ringing", callType: "outbound" })
      .returning();
    await callsService.endFromStream({ callId: call.id, outcome: "failed" });
    const rows = await ledgerFor(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billableSeconds: 0, billableReason: "unanswered", outcome: "unanswered" });
  });

  it("the stale-call reaper meters the calls it closes", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: M.orgId, agentId: agentM, status: "in_progress", callType: "outbound", startedAt: new Date(Date.now() - 4 * 60_000) })
      .returning();
    await callsService.reapStaleCalls({ pendingMs: 0, inProgressMs: 0 });
    const rows = await ledgerFor(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].billableSeconds).toBeGreaterThanOrEqual(240);
  });

  // Seeds 450 calls and reconciles them in batches: correct but slow under a full-suite load, where the 5 s default
  // timed out. A longer budget for this one test only; the assertions are unchanged.
  it("a backlog larger than one reconcile batch is fully counted before a quota decision", { timeout: 30_000 }, async () => {
    const start = new Date();
    const values = Array.from({ length: 450 }, () => ({
      organizationId: M.orgId,
      agentId: agentM,
      status: "completed" as const,
      callType: "outbound" as const,
      startedAt: start,
      endedAt: new Date(start.getTime() + 30_000),
    }));
    await db.insert(calls).values(values);
    const snap = await evaluateEntitlements(M.orgId);
    expect(snap.reason).toBe("OK");
    // 450 x (30s -> 60s) plus the earlier lifecycle calls
    expect(snap.usage.usedSeconds).toBeGreaterThanOrEqual(450 * 60);
    const unmetered = await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`select count(*)::int n from calls c where c.organization_id = ${M.orgId} and c.status in ('completed','failed') and not exists (select 1 from usage_ledger l where l.organization_id = c.organization_id and l.idempotency_key = 'call:' || c.id::text)`,
    );
    expect((unmetered as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });
});

describe("subscription time behaviour", () => {
  it("period end -> past_due (still allowed) -> suspended after the grace window, evaluated at the given instant", async () => {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, M.orgId));
    const end = row.currentPeriodEnd.getTime();
    expect((await evaluateEntitlements(M.orgId, new Date(end - 1))).status).toBe("active");
    const grace = await evaluateEntitlements(M.orgId, new Date(end + 1 * day));
    expect(grace).toMatchObject({ status: "past_due", allowed: true });
    const suspended = await evaluateEntitlements(M.orgId, new Date(end + 4 * day));
    expect(suspended).toMatchObject({ status: "suspended", allowed: false, reason: "SUBSCRIPTION_SUSPENDED" });
  });

  it("a verified payment rolls the period over: old usage no longer counts, new usage does", async () => {
    const provider = createMockPaymentProvider("audit-secret-0123456789abcdef");
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, M.orgId));
    const before = await evaluateEntitlements(M.orgId, new Date(row.currentPeriodStart.getTime() + day));
    expect(before.usage.usedSeconds).toBeGreaterThan(0);

    const ps = new Date(row.currentPeriodEnd.getTime());
    const pe = new Date(ps.getTime() + 30 * day);
    const raw = JSON.stringify({ id: "evt_rollover_1", type: "payment_succeeded", organizationId: M.orgId, planKey: "starter", periodStart: ps.toISOString(), periodEnd: pe.toISOString(), occurredAt: ps.toISOString() });
    const event = provider.verifyWebhook(raw, { "x-mock-signature": provider.sign(raw) });
    expect(await paymentEventsService.handleVerified(sys(M), event)).toBe("applied");

    const mid = new Date(ps.getTime() + 2 * day);
    const next = await evaluateEntitlements(M.orgId, mid);
    expect(next).toMatchObject({ status: "active", allowed: true });
    expect(next.usage.usedSeconds).toBe(0); // the new period starts empty
  });

  it("an unrecognised subscription status fails closed", async () => {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, M.orgId));
    vi.spyOn(subscriptionsRepository, "find").mockResolvedValueOnce({ ...row, status: "paused_by_future_version" as never });
    const snap = await evaluateEntitlements(M.orgId);
    expect(snap).toMatchObject({ allowed: false });
    expect(["STATE_UNAVAILABLE"]).toContain(snap.reason);
  });
});

describe("no client-supplied value can move billing", () => {
  it("duration, cost, organization and status are rejected or ignored on every billing write route", async () => {
    for (const [path, body] of [
      ["/api/billing/usage/reconcile", { durationSeconds: 1, organizationId: M.orgId }],
      ["/api/billing/trial", { status: "active", pricePaise: 0 }],
      ["/api/billing/plan-change", { planKey: "starter", pricePaise: 1 }],
      ["/api/billing/cancel", { periodEnd: "2030-01-01" }],
    ] as const) {
      expect((await http(cookieS, path, { method: "POST", body })).status, path).toBe(400);
    }
    // the read side takes no organization either: S sees only its own (empty) usage regardless of the query string
    const res = await http(cookieS, `/api/billing/usage?organizationId=${M.orgId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("seat caps (maxAgents, maxTeamMembers)", () => {
  const agentBody = (name: string) => ({ name, personaName: "Asha" });

  it("unmanaged organizations are not capped", async () => {
    for (let i = 0; i < 5; i++) expect((await http(cookieU, "/api/agents", { method: "POST", body: agentBody(`U-${i}`) })).status).toBe(201);
  });

  it("parallel agent creation cannot exceed the plan cap; the refusal explains the next step", async () => {
    await sub(S, { planKey: "starter", limitOverrides: { maxAgents: 4, maxTeamMembers: 3 } });
    const existing = await activeAgents(S);
    const free = 4 - existing;
    expect(free).toBeGreaterThan(0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => http(cookieS, "/api/agents", { method: "POST", body: agentBody(`S-${i}`) })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(free);
    const refused = results.filter((r) => r.status !== 201);
    for (const r of refused) {
      expect(r.status).toBe(429);
      expect(r.body.code).toBe("AGENT_LIMIT_REACHED");
      expect(String(r.body.error)).toMatch(/upgrade|Archive/i);
      expect(JSON.stringify(r.body)).not.toMatch(/insert into|Failed query/i); // raw driver text never leaks
    }
    expect(await activeAgents(S)).toBe(4);
  });

  it("unarchiving into a full plan is refused; archiving frees a seat", async () => {
    const list = (await http(cookieS, "/api/agents?includeArchived=true")).body.data as Array<{ id: string; status: string; isDefault: boolean }>;
    const victim = list.find((a) => a.status === "active" && !a.isDefault)!;
    expect((await http(cookieS, `/api/agents/${victim.id}/archive`, { method: "POST", body: {} })).status).toBe(200);
    expect((await http(cookieS, "/api/agents", { method: "POST", body: agentBody("S-after-archive") })).status).toBe(201);
    const back = await http(cookieS, `/api/agents/${victim.id}/unarchive`, { method: "POST", body: {} });
    expect(back.status).toBe(429);
    expect(back.body.code).toBe("AGENT_LIMIT_REACHED");
  });

  it("team seats count members and pending invitations; parallel invitations cannot exceed the cap", async () => {
    // S has 1 member (owner), cap 3 => 2 invitations may be issued.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => http(cookieS, "/api/users/invitations", { method: "POST", body: { email: `invitee-${i}-${Date.now()}@example.test`, role: "AGENT" } })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(429);
      expect(r.body.code).toBe("TEAM_MEMBER_LIMIT_REACHED");
    }
    const overview = await http(cookieS, "/api/billing/overview");
    expect(overview.body.data.seats).toEqual({ agents: { used: 4, limit: 4 }, teamMembers: { used: 3, limit: 3 } });
  });

  it("caps are per organization: another tenant on the same plan is unaffected by S being full", async () => {
    await sub(T, { planKey: "starter", limitOverrides: { maxAgents: 3, maxTeamMembers: 5 } });
    expect((await http(cookieT, "/api/agents", { method: "POST", body: agentBody("T-1") })).status).toBe(201);
    const t = await http(cookieT, "/api/billing/overview");
    expect(t.body.data.seats.agents.limit).toBe(3);
    expect(t.body.data.seats.agents.used).toBe(2); // its fixture default agent + T-1, never S's
  });
});
