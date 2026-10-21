/**
 * Billing foundation against real PostgreSQL (row-level security, the append-only trigger, transactions, the
 * advisory-locked call path). Runs as the restricted runtime role; fixtures use the administrative connection.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql, db as runtimeDb } from "../../db/client.js";
import { auditLogs, billingEvents, calls, plans, subscriptions, usageLedger } from "../../db/schema.js";
import { systemContext, userContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { LimitExceededError } from "../../shared/errors.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { callsService } from "../calls/calls.service.js";
import { subscriptionsRepository } from "../../db/repositories/billing.repository.js";
import { billingService } from "./billing.service.js";
import { meteringService } from "./metering.service.js";
import { meteringEngine } from "./metering-engine.js";
import { evaluateEntitlements } from "./entitlements-engine.js";
import { callAdmission } from "./call-admission.js";
import { paymentEventsService } from "./payment-events.service.js";
import { createMockPaymentProvider } from "./payment-provider.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant; // managed: starts a trial through the API
let B: TestTenant; // managed by direct fixture
let L: TestTenant; // legacy / unmanaged (no subscription row)
let cookieOwnerA = "";
let cookieAdminA = "";
let cookieManagerA = "";
let cookieAgentA = "";
let cookieOwnerB = "";
let agentA = "";
let agentB = "";
let agentL = "";

const orgIds = () => [A.orgId, B.orgId, L.orgId];
const sys = (t: TestTenant) => systemContext(t.orgId, "test");

async function http(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function insertCall(
  t: TestTenant,
  agentId: string,
  o: { status: "completed" | "failed" | "in_progress"; startedAt?: Date | null; seconds?: number | null; callType?: "outbound" | "test"; endedAt?: Date | null },
) {
  const startedAt = o.startedAt === undefined ? new Date() : o.startedAt;
  const endedAt =
    o.endedAt !== undefined ? o.endedAt : startedAt && o.seconds != null ? new Date(startedAt.getTime() + o.seconds * 1000) : null;
  const [row] = await db
    .insert(calls)
    .values({ organizationId: t.orgId, agentId, status: o.status, callType: o.callType ?? "outbound", startedAt, endedAt })
    .returning();
  return row;
}

async function setSub(t: TestTenant, patch: Partial<typeof subscriptions.$inferInsert>) {
  await db.update(subscriptions).set(patch).where(eq(subscriptions.organizationId, t.orgId));
}

async function giveSubscription(t: TestTenant, v: Partial<typeof subscriptions.$inferInsert> & { planKey: string }) {
  const now = new Date();
  await db.insert(subscriptions).values({
    organizationId: t.orgId,
    status: "active",
    currentPeriodStart: new Date(now.getTime() - 5 * 86_400_000),
    currentPeriodEnd: new Date(now.getTime() + 25 * 86_400_000),
    ...v,
  });
}

/** The ledger is append-only, even for the owner role: tests remove their own rows with triggers disabled. */
async function purgeLedger(ids: string[]) {
  await adminSql!.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe("delete from usage_ledger where organization_id = any($1::uuid[])", [ids]);
  });
}

beforeAll(async () => {
  A = await createTenant("BILL_A", { modules: [] });
  B = await createTenant("BILL_B", { modules: [] });
  L = await createTenant("BILL_L", { modules: [] });
  const mk = (t: TestTenant, label: string) =>
    createDefaultAgent(t.orgId, { name: label, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  agentA = (await mk(A, "A")).id;
  agentB = (await mk(B, "B")).id;
  agentL = (await mk(L, "L")).id;
  const adminA = await createMember(A.orgId, "ADMIN");
  const managerA = await createMember(A.orgId, "MANAGER");
  const agentUserA = await createMember(A.orgId, "AGENT");
  ({ app, baseUrl } = await startTestApp());
  cookieOwnerA = await loginCookie(baseUrl, A.email);
  cookieAdminA = await loginCookie(baseUrl, adminA.email);
  cookieManagerA = await loginCookie(baseUrl, managerA.email);
  cookieAgentA = await loginCookie(baseUrl, agentUserA.email);
  cookieOwnerB = await loginCookie(baseUrl, B.email);
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
  process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
  process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await purgeLedger(orgIds());
  await db.delete(billingEvents).where(inArray(billingEvents.organizationId, orgIds()));
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds()));
  await db.delete(subscriptions).where(inArray(subscriptions.organizationId, orgIds()));
  await cleanupTenants();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BILLING_ENFORCEMENT;
});

describe("plan catalog", () => {
  it("lists the public plans with prices in paise and entitlements; any member may read it", async () => {
    const res = await http(cookieAgentA, "/api/billing/plans");
    expect(res.status).toBe(200);
    const keys = (res.body.data as Array<{ key: string }>).map((p) => p.key);
    expect(keys).toEqual(["starter", "growth", "business", "enterprise"]);
    const starter = (res.body.data as any[]).find((p) => p.key === "starter");
    expect(starter).toMatchObject({ pricePaise: 299900, currency: "INR", includedMinutes: 300, selfServe: true });
    expect(starter.entitlements).toMatchObject({ maxConcurrentCalls: 3, maxAgents: 3, maxTeamMembers: 5 });
    expect((res.body.data as any[]).find((p) => p.key === "enterprise")).toMatchObject({ pricePaise: null, selfServe: false });
  });

  it("the runtime role can read the catalog but never change it", async () => {
    await expect(runtimeDb.update(plans).set({ pricePaise: 1 }).where(eq(plans.key, "starter"))).rejects.toThrow();
    await expect(runtimeDb.insert(plans).values({ key: "evil", name: "Evil" })).rejects.toThrow();
    const [row] = await db.select().from(plans).where(eq(plans.key, "starter"));
    expect(row.pricePaise).toBe(299900);
  });
});

describe("permissions and mass assignment", () => {
  it("only OWNER/ADMIN can read billing state; only OWNER can change it", async () => {
    expect((await http(cookieManagerA, "/api/billing/overview")).status).toBe(403);
    expect((await http(cookieAgentA, "/api/billing/overview")).status).toBe(403);
    expect((await http(cookieAdminA, "/api/billing/overview")).status).toBe(200);
    for (const [path, body] of [
      ["/api/billing/trial", {}],
      ["/api/billing/plan-change", { planKey: "starter" }],
      ["/api/billing/cancel", {}],
      ["/api/billing/resume", {}],
      ["/api/billing/usage/reconcile", {}],
    ] as const) {
      for (const cookie of [cookieAdminA, cookieManagerA, cookieAgentA]) {
        expect((await http(cookie, path, { method: "POST", body })).status, `${path}`).toBe(403);
      }
    }
  });

  it("rejects unknown properties instead of applying them", async () => {
    for (const body of [{ organizationId: B.orgId }, { status: "active" }, { planKey: "starter", organizationId: B.orgId }]) {
      const path = "planKey" in body ? "/api/billing/plan-change" : "/api/billing/trial";
      expect((await http(cookieOwnerA, path, { method: "POST", body })).status).toBe(400);
    }
    expect((await http(cookieOwnerA, "/api/billing/usage?limit=1000")).status).toBe(400);
    expect((await http(cookieOwnerA, "/api/billing/usage?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("unmanaged (pre-billing) organizations", () => {
  it("are reported as unmanaged, allowed, and place calls exactly as before", async () => {
    const owner = cookieOwnerB; // B has no subscription yet at this point of the file
    const res = await http(owner, "/api/billing/overview");
    expect(res.body.data).toMatchObject({ managed: false, allowed: true, reason: "UNMANAGED_LEGACY" });
    await expect(
      callsService.createCall(sys(L), { agentId: agentL, callType: "outbound", counterpartyNumber: "+919000011111" }),
    ).resolves.toMatchObject({ organizationId: L.orgId });
  });
});

describe("onboarding the subscription: trial", () => {
  it("OWNER starts a trial from the catalog (14 days, 30 minutes); a second attempt is a 409", async () => {
    const res = await http(cookieOwnerA, "/api/billing/trial", { method: "POST", body: {} });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ managed: true, allowed: true, status: "trialing", reason: "OK" });
    expect(res.body.data.plan).toMatchObject({ key: "trial" });
    expect(res.body.data.usage).toMatchObject({ includedMinutes: 30, usedMinutes: 0, remainingMinutes: 30 });
    const days = (Date.parse(res.body.data.trialEndsAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect((await http(cookieOwnerA, "/api/billing/trial", { method: "POST", body: {} })).status).toBe(409);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, A.orgId), eq(auditLogs.action, "subscription.trial_started")));
    expect(audit).toHaveLength(1);
  });

  it("concurrent trial starts create exactly one subscription", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => http(cookieOwnerB, "/api/billing/trial", { method: "POST", body: {} })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, B.orgId));
    expect(rows).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("one organization's overview and usage history never include another's", async () => {
    await insertCall(A, agentA, { status: "completed", seconds: 61 });
    await insertCall(B, agentB, { status: "completed", seconds: 30 });
    await http(cookieOwnerA, "/api/billing/usage/reconcile", { method: "POST", body: {} });
    await http(cookieOwnerB, "/api/billing/usage/reconcile", { method: "POST", body: {} });

    const a = await http(cookieOwnerA, "/api/billing/usage");
    const b = await http(cookieOwnerB, "/api/billing/usage");
    const aSeconds = (a.body.data as any[]).map((r) => r.billableSeconds);
    const bSeconds = (b.body.data as any[]).map((r) => r.billableSeconds);
    expect(aSeconds).toContain(120);
    expect(bSeconds).toContain(60);
    const aIds = new Set((a.body.data as any[]).map((r) => r.id));
    for (const r of b.body.data as any[]) expect(aIds.has(r.id)).toBe(false);

    // the rows themselves are RLS-protected: the runtime role scoped to B cannot see A's ledger
    const { runInTenant } = await import("../../db/tenant-context.js");
    const seen = await runInTenant({ organizationId: B.orgId }, async () => await runtimeDb.select().from(usageLedger));
    expect(seen.every((r) => r.organizationId === B.orgId)).toBe(true);
  });

  it("a forged cursor or organization id cannot reach another tenant's rows", async () => {
    const aRow = (await http(cookieOwnerA, "/api/billing/usage")).body.data[0];
    // B presenting a cursor built from A's row id just paginates B's own data
    const forged = Buffer.from(JSON.stringify({ t: new Date(Date.now() + 1000).toISOString(), id: aRow.id })).toString("base64url");
    const res = await http(cookieOwnerB, `/api/billing/usage?cursor=${forged}`);
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).every((r) => r.id !== aRow.id)).toBe(true);
    const spoof = await http(cookieOwnerB, `/api/billing/overview?organizationId=${A.orgId}`);
    expect(spoof.body.data.plan.key).toBe("trial");
    expect(spoof.body.data.usage.usedSeconds).toBe(60); // B's own 30s call (A's would be 120): the query param is ignored
  });
});

describe("usage metering", () => {
  it("bills from the call record with the rounding policy and keeps non-billable calls as zero rows", async () => {
    const c1 = await insertCall(B, agentB, { status: "completed", seconds: 125 });
    const c2 = await insertCall(B, agentB, { status: "failed", startedAt: null, endedAt: new Date() });
    const c3 = await insertCall(B, agentB, { status: "completed", seconds: 1 });
    const c4 = await insertCall(B, agentB, { status: "completed", seconds: 500, callType: "test" });
    await meteringEngine.reconcile(B.orgId);
    const rows = await db.select().from(usageLedger).where(eq(usageLedger.organizationId, B.orgId));
    const by = (id: string) => rows.find((r) => r.callId === id)!;
    expect(by(c1.id)).toMatchObject({ billableSeconds: 180, billableMinutes: 3, billableReason: "billed", state: "final", idempotencyKey: `call:${c1.id}` });
    expect(by(c2.id)).toMatchObject({ billableSeconds: 0, billableReason: "unanswered", outcome: "unanswered" });
    expect(by(c3.id)).toMatchObject({ billableSeconds: 0, billableReason: "too_short" });
    expect(by(c4.id)).toMatchObject({ billableSeconds: 0, billableReason: "test_call" });
    expect(by(c1.id).roundingPolicy).toBe("ceil_60s_per_call");
  });

  it("is idempotent: retries and 10 concurrent deliveries produce one row and one charge", async () => {
    const call = await insertCall(B, agentB, { status: "completed", seconds: 90 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        meteringService.recordCall(sys(B), { callId: call.id, source: i % 2 ? "call_lifecycle" : "mock" }),
      ),
    );
    expect(results.filter((r) => r.status === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(9);
    await meteringEngine.reconcile(B.orgId);
    await meteringEngine.reconcile(B.orgId);
    const rows = await db.select().from(usageLedger).where(and(eq(usageLedger.organizationId, B.orgId), eq(usageLedger.callId, call.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].billableSeconds).toBe(120);
  });

  it("does not meter a call that is still in progress; it is metered once it ends", async () => {
    const call = await insertCall(B, agentB, { status: "in_progress", endedAt: null });
    expect(await meteringService.recordCall(sys(B), { callId: call.id })).toEqual({ status: "not_terminal" });
    await db.update(calls).set({ status: "completed", endedAt: new Date(call.startedAt!.getTime() + 61_000) }).where(eq(calls.id, call.id));
    expect(await meteringService.recordCall(sys(B), { callId: call.id })).toMatchObject({ status: "recorded", entry: { billableSeconds: 120 } });
  });

  it("handles an interrupted call out of order: pending first, then superseded by the final measurement", async () => {
    const call = await insertCall(B, agentB, { status: "failed", endedAt: null, seconds: null });
    const first = await meteringService.recordCall(sys(B), { callId: call.id });
    expect(first).toMatchObject({ status: "recorded", entry: { state: "pending", billableSeconds: 0, billableReason: "interrupted" } });
    const before = (await evaluateEntitlements(B.orgId)).usage.pendingEntries;
    expect(before).toBeGreaterThanOrEqual(1);

    // the end time arrives later (late callback / reaper)
    await db.update(calls).set({ endedAt: new Date(call.startedAt!.getTime() + 45_000) }).where(eq(calls.id, call.id));
    const report = await meteringEngine.reconcile(B.orgId);
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(usageLedger).where(eq(usageLedger.callId, call.id));
    expect(rows).toHaveLength(2);
    const pending = rows.find((r) => r.idempotencyKey === `call:${call.id}`)!;
    const final = rows.find((r) => r.idempotencyKey === `call:${call.id}:final`)!;
    expect(pending.state).toBe("superseded"); // history retained, not deleted
    expect(final).toMatchObject({ state: "final", billableSeconds: 60, supersedesId: pending.id });
    // totals count the call once
    const again = await meteringEngine.reconcile(B.orgId);
    expect(again.finalized).toBe(0);
  });

  it("corrections append a superseding row, keep history, are audited, and are operator-only", async () => {
    const call = await insertCall(B, agentB, { status: "completed", seconds: 300 });
    const original = (await meteringService.recordCall(sys(B), { callId: call.id })) as { entry: { id: string } };
    await expect(
      meteringService.correct(userContext(B.orgId, B.userId, "OWNER"), { ledgerId: original.entry.id, billableSeconds: 0, reason: "x", clientKey: "k" }),
    ).rejects.toThrow(/operator/i);

    const input = { ledgerId: original.entry.id, billableSeconds: 60, reason: "provider reported a dropped line", clientKey: "ticket-1" };
    const corrected = await meteringService.correct(sys(B), input);
    expect(corrected).toMatchObject({ entryType: "correction", billableSeconds: 60, billableReason: "corrected", supersedesId: original.entry.id });
    expect(await meteringService.correct(sys(B), input)).toMatchObject({ id: corrected.id }); // retry is a no-op
    await expect(meteringService.correct(sys(B), { ...input, clientKey: "other" })).rejects.toThrow(/already been corrected/i);
    const [orig] = await db.select().from(usageLedger).where(eq(usageLedger.id, original.entry.id));
    expect(orig).toMatchObject({ state: "superseded", billableSeconds: 300 });
    const history = await http(cookieOwnerB, "/api/billing/usage?includeSuperseded=true&limit=100");
    expect((history.body.data as any[]).filter((r) => r.callId === call.id)).toHaveLength(2);
  });

  it("the ledger cannot be rewritten or deleted, even with the owner connection", async () => {
    const [row] = await db.select().from(usageLedger).where(and(eq(usageLedger.organizationId, B.orgId), eq(usageLedger.billableReason, "billed"))).limit(1);
    const reason = async (p: Promise<unknown>) => {
      const err = (await p.then(() => null, (e: unknown) => e)) as { message?: string; cause?: { message?: string } } | null;
      return `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
    };
    expect(await reason(db.update(usageLedger).set({ billableSeconds: 0 }).where(eq(usageLedger.id, row.id)) as unknown as Promise<unknown>)).toMatch(/immutable/i);
    expect(await reason(db.delete(usageLedger).where(eq(usageLedger.id, row.id)) as unknown as Promise<unknown>)).toMatch(/append-only/i);
    await expect(runtimeDb.delete(usageLedger).where(eq(usageLedger.id, row.id))).rejects.toThrow();
  });

  it("aggregates by billing period: usage exactly at the period end belongs to the next period", async () => {
    const start = new Date("2026-03-01T00:00:00Z");
    const end = new Date("2026-04-01T00:00:00Z");
    await setSub(B, { currentPeriodStart: start, currentPeriodEnd: end, status: "active", planKey: "starter", trialEndsAt: null });
    const mk = (endedAt: Date) => insertCall(B, agentB, { status: "completed", startedAt: new Date(endedAt.getTime() - 60_000), endedAt });
    await mk(new Date(start.getTime())); // first instant of the period: counted
    await mk(new Date(end.getTime() - 1)); // last millisecond: counted
    await mk(new Date(end.getTime())); // boundary: next period
    await mk(new Date(start.getTime() - 1)); // before: previous period
    await meteringEngine.reconcile(B.orgId);
    const snap = await evaluateEntitlements(B.orgId, new Date("2026-03-15T00:00:00Z"));
    expect(snap.usage.usedSeconds).toBe(120);
    expect(snap.usage.usedMinutes).toBe(2);
    expect(snap.usage.includedMinutes).toBe(300);
  });
});

describe("entitlements and quotas", () => {
  it("allows an active trial, and refuses with MINUTES_EXHAUSTED once the allowance is used", async () => {
    await expect(callAdmission.admit(A.orgId)).resolves.toBeTruthy();
    await insertCall(A, agentA, { status: "completed", seconds: 30 * 60 });
    const snap = await evaluateEntitlements(A.orgId);
    expect(snap).toMatchObject({ allowed: false, reason: "MINUTES_EXHAUSTED", nextStep: "upgrade" });
    expect(snap.usage.remainingMinutes).toBe(0);
    const refused = await callsService
      .createCall(sys(A), { agentId: agentA, callType: "outbound", counterpartyNumber: "+919000022222" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LimitExceededError);
    expect((refused as LimitExceededError).code).toBe("MINUTES_EXHAUSTED");
    expect((refused as Error).message).toMatch(/Choose a plan/);
    // the refusal created no call row
    const created = await db.select().from(calls).where(and(eq(calls.organizationId, A.orgId), eq(calls.counterpartyNumber, "+919000022222")));
    expect(created).toHaveLength(0);
  });

  it("the API surfaces the structured reason for the dashboard", async () => {
    const res = await http(cookieOwnerA, "/api/billing/overview");
    expect(res.body.data).toMatchObject({ allowed: false, reason: "MINUTES_EXHAUSTED", nextStep: "upgrade", paymentsEnabled: false, canManage: true });
  });

  it("an expired trial is refused with TRIAL_EXPIRED even though the stored status was never swept", async () => {
    await giveSubscription(L, { planKey: "trial", status: "trialing", trialEndsAt: new Date(Date.now() - 1000), currentPeriodStart: new Date(Date.now() - 15 * 86_400_000), currentPeriodEnd: new Date(Date.now() - 1000) });
    const snap = await evaluateEntitlements(L.orgId);
    expect(snap).toMatchObject({ allowed: false, reason: "TRIAL_EXPIRED", status: "expired", storedStatus: "trialing" });
    await expect(callAdmission.admit(L.orgId)).rejects.toMatchObject({ code: "TRIAL_EXPIRED" });
  });

  it("suspended, canceled and unconfigured-enterprise subscriptions are refused with their own reasons", async () => {
    await setSub(L, { planKey: "starter", status: "suspended", trialEndsAt: null, currentPeriodStart: new Date(Date.now() - 86_400_000), currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    expect(await evaluateEntitlements(L.orgId)).toMatchObject({ allowed: false, reason: "SUBSCRIPTION_SUSPENDED", nextStep: "update_payment" });
    await setSub(L, { status: "canceled" });
    expect(await evaluateEntitlements(L.orgId)).toMatchObject({ allowed: false, reason: "SUBSCRIPTION_CANCELED" });
    await setSub(L, { status: "active", planKey: "enterprise" });
    expect(await evaluateEntitlements(L.orgId)).toMatchObject({ allowed: false, reason: "LIMITS_NOT_CONFIGURED", nextStep: "contact_sales" });
    await setSub(L, { limitOverrides: { includedMinutes: 10_000, maxConcurrentCalls: 50 } });
    expect(await evaluateEntitlements(L.orgId)).toMatchObject({ allowed: true, reason: "OK", limits: { maxConcurrentCalls: 50 }, usage: { includedMinutes: 10_000 } });
  });

  it("fails closed when subscription state cannot be read", async () => {
    vi.spyOn(subscriptionsRepository, "find").mockRejectedValueOnce(new Error("db down"));
    expect(await evaluateEntitlements(L.orgId)).toMatchObject({ allowed: false, reason: "STATE_UNAVAILABLE" });
    vi.spyOn(subscriptionsRepository, "find").mockRejectedValueOnce(new Error("db down"));
    await expect(callAdmission.admit(L.orgId)).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
  });

  it("enforces the plan's concurrent-call cap atomically under parallel call creation", async () => {
    await setSub(L, { planKey: "starter", status: "active", limitOverrides: { maxConcurrentCalls: 3 } });
    const already = (await db.select().from(calls).where(and(eq(calls.organizationId, L.orgId), inArray(calls.status, ["initiating", "ringing", "in_progress"])))).length;
    const free = 3 - already;
    expect(free).toBeGreaterThan(0);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => callsService.createCall(sys(L), { agentId: agentL, callType: "outbound", counterpartyNumber: "+919000033333" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(free);
    expect(refused).toHaveLength(8 - free);
    for (const r of refused) expect((r.reason as LimitExceededError).code).toBe("CONCURRENT_CALL_LIMIT");
  });

  it("BILLING_ENFORCEMENT=off reports the state but refuses nothing", async () => {
    process.env.BILLING_ENFORCEMENT = "off";
    const snap = await evaluateEntitlements(A.orgId);
    expect(snap).toMatchObject({ allowed: true, reason: "ENFORCEMENT_DISABLED" });
    await expect(callAdmission.admit(A.orgId)).resolves.toEqual({ maxConcurrentCalls: null, minutes: null });
  });
});

describe("cancellation workflow", () => {
  it("OWNER cancels at period end and can resume; the plan stays usable until then", async () => {
    const c = await http(cookieOwnerB, "/api/billing/cancel", { method: "POST", body: {} });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ cancelAtPeriodEnd: true });
    const r = await http(cookieOwnerB, "/api/billing/resume", { method: "POST", body: {} });
    expect(r.body.data).toMatchObject({ cancelAtPeriodEnd: false });
    expect((await http(cookieOwnerB, "/api/billing/resume", { method: "POST", body: {} })).status).toBe(409);
  });

  it("a plan-change request records intent and changes no entitlement", async () => {
    const res = await http(cookieOwnerA, "/api/billing/plan-change", { method: "POST", body: { planKey: "growth" } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ requestedPlanKey: "growth", effective: false, paymentsEnabled: false });
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, A.orgId));
    expect(sub).toMatchObject({ planKey: "trial", status: "trialing", scheduledPlanKey: "growth" });
    expect((await http(cookieOwnerA, "/api/billing/plan-change", { method: "POST", body: { planKey: "no-such-plan" } })).status).toBe(404);
    expect((await http(cookieOwnerA, "/api/billing/plan-change", { method: "POST", body: { planKey: "trial" } })).status).toBe(404);
  });
});

describe("verified payment events", () => {
  const provider = createMockPaymentProvider("integration-secret-0123456789");
  const bodyFor = (org: string, id: string, type = "payment_succeeded", planKey = "growth") =>
    JSON.stringify({
      id,
      type,
      organizationId: org,
      planKey,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      occurredAt: new Date().toISOString(),
    });
  const verify = (raw: string) => provider.verifyWebhook(raw, { "x-mock-signature": provider.sign(raw) });

  it("activates the plan once; replays and concurrent redeliveries do nothing more", async () => {
    const event = verify(bodyFor(A.orgId, "evt_activate_1"));
    const results = await Promise.all(Array.from({ length: 5 }, () => paymentEventsService.handleVerified(sys(A), event)));
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate" || r === "conflict").length).toBe(4);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, A.orgId));
    expect(sub).toMatchObject({ status: "active", planKey: "growth", scheduledPlanKey: null, paymentProvider: "mock" });
    expect(await paymentEventsService.handleVerified(sys(A), event)).toBe("duplicate");
    const events = await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, "evt_activate_1"));
    expect(events).toHaveLength(1);
    // entitlements follow the new plan and period (the trial's used minutes belong to the old period)
    const snap = await evaluateEntitlements(A.orgId);
    expect(snap).toMatchObject({ allowed: true, status: "active", plan: { key: "growth" }, usage: { includedMinutes: 2000 } });
  });

  it("refuses unverified input, user actors, and events addressed to a different organization", async () => {
    const raw = bodyFor(B.orgId, "evt_bad");
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": "ab".repeat(32) })).toThrow();
    const event = verify(raw);
    await expect(paymentEventsService.handleVerified(userContext(B.orgId, B.userId, "OWNER"), event)).rejects.toThrow(/system only/i);
    await expect(paymentEventsService.handleVerified(sys(A), event)).rejects.toThrow(/does not belong/i);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, B.orgId));
    expect(sub.planKey).toBe("starter"); // untouched
  });

  it("a failed payment moves an active subscription to past_due and calls continue in the grace window", async () => {
    const r = await paymentEventsService.handleVerified(sys(A), verify(bodyFor(A.orgId, "evt_fail_1", "payment_failed")));
    expect(r).toBe("applied");
    const snap = await evaluateEntitlements(A.orgId);
    expect(snap).toMatchObject({ status: "past_due", allowed: true, nextStep: "update_payment" });
  });

  it("an unknown plan in a verified event is rejected without recording it as applied", async () => {
    await expect(paymentEventsService.handleVerified(sys(A), verify(bodyFor(A.orgId, "evt_unknown_plan", "payment_succeeded", "platinum")))).rejects.toThrow(/plan/i);
    expect(await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, "evt_unknown_plan"))).toHaveLength(0);
  });
});

describe("billing service direct calls", () => {
  it("refuse a context without the permission (service-layer authorization, not just routes)", async () => {
    const agentCtx = userContext(A.orgId, A.userId, "AGENT");
    await expect(billingService.overview(agentCtx)).rejects.toThrow();
    await expect(billingService.cancel(userContext(A.orgId, A.userId, "ADMIN"))).rejects.toThrow();
  });
});
