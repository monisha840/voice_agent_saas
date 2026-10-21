/**
 * Billing security regression tests (real PostgreSQL, restricted runtime role, HTTP app). Complements billing.test.ts:
 * everything here is adversarial - cross-tenant access, forged identifiers, privilege escalation, replay, races.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql, db as runtimeDb } from "../../db/client.js";
import { runInTenant } from "../../db/tenant-context.js";
import { billingEvents, calls, subscriptions, usageLedger } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { LimitExceededError } from "../../shared/errors.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { callsService } from "../calls/calls.service.js";
import { meteringService } from "./metering.service.js";
import { meteringEngine } from "./metering-engine.js";
import { paymentEventsService } from "./payment-events.service.js";
import { createMockPaymentProvider } from "./payment-provider.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let agentA = "";
let agentB = "";
const cookies: Record<string, string> = {};

const orgIds = () => [A.orgId, B.orgId];
const sys = (t: TestTenant) => systemContext(t.orgId, "test");

async function http(cookie: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(cookie ? { cookie } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
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

async function subOf(t: TestTenant) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, t.orgId));
  return row;
}

async function endedCall(t: TestTenant, agentId: string, seconds: number) {
  const startedAt = new Date(Date.now() - seconds * 1000 - 1000);
  const [row] = await db
    .insert(calls)
    .values({ organizationId: t.orgId, agentId, status: "completed", callType: "outbound", startedAt, endedAt: new Date(startedAt.getTime() + seconds * 1000) })
    .returning();
  return row;
}

async function purgeLedger(ids: string[]) {
  await adminSql!.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe("delete from usage_ledger where organization_id = any($1::uuid[])", [ids]);
  });
}

beforeAll(async () => {
  A = await createTenant("BSEC_A", { modules: [] });
  B = await createTenant("BSEC_B", { modules: [] });
  const mk = (t: TestTenant) =>
    createDefaultAgent(t.orgId, { name: "x", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  agentA = (await mk(A)).id;
  agentB = (await mk(B)).id;
  await giveSubscription(A, { planKey: "starter" });
  await giveSubscription(B, { planKey: "starter" });
  const adminA = await createMember(A.orgId, "ADMIN");
  const managerA = await createMember(A.orgId, "MANAGER");
  const agentUserA = await createMember(A.orgId, "AGENT");
  ({ app, baseUrl } = await startTestApp());
  cookies.ownerA = await loginCookie(baseUrl, A.email);
  cookies.ownerB = await loginCookie(baseUrl, B.email);
  cookies.adminA = await loginCookie(baseUrl, adminA.email);
  cookies.managerA = await loginCookie(baseUrl, managerA.email);
  cookies.agentA = await loginCookie(baseUrl, agentUserA.email);
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
  process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
  process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await purgeLedger(orgIds());
  await db.delete(billingEvents).where(inArray(billingEvents.organizationId, orgIds()));
  await db.delete(subscriptions).where(inArray(subscriptions.organizationId, orgIds()));
  await cleanupTenants();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("row-level security as the runtime role", () => {
  it("raw SQL scoped to one tenant cannot read another tenant's billing rows (and none without a scope)", async () => {
    const call = await endedCall(A, agentA, 90);
    await meteringEngine.meterCall(A.orgId, call, "call_lifecycle");
    await db.insert(billingEvents).values({
      organizationId: A.orgId, provider: "mock", providerEventId: "evt_rls_seed", eventType: "payment_failed", outcome: "ignored", payloadDigest: "d".repeat(64),
    });
    for (const table of ["subscriptions", "usage_ledger", "billing_events"] as const) {
      const own = await runInTenant({ organizationId: A.orgId }, async () => await runtimeDb.execute(sql.raw(`select organization_id from ${table}`)));
      expect(own.length, table).toBeGreaterThan(0);
      const other = await runInTenant({ organizationId: B.orgId }, async () =>
        await runtimeDb.execute(sql.raw(`select organization_id from ${table} where organization_id = '${A.orgId}'`)),
      );
      expect(other.length, table).toBe(0);
      const unscoped = await runtimeDb.execute(sql.raw(`select organization_id from ${table}`));
      expect(unscoped.length, `${table} without scope`).toBe(0);
    }
  });

  it("cannot write another tenant's rows: UPDATE touches nothing, INSERT is rejected by WITH CHECK", async () => {
    const before = await subOf(A);
    const upd = await runInTenant({ organizationId: B.orgId }, async () =>
      await runtimeDb.execute(sql.raw(`update subscriptions set plan_key = 'business', status = 'active' where organization_id = '${A.orgId}' returning id`)),
    );
    expect(upd.length).toBe(0);
    expect((await subOf(A)).planKey).toBe(before.planKey);

    await expect(
      runInTenant({ organizationId: B.orgId }, async () =>
        await runtimeDb.execute(
          sql.raw(
            `insert into usage_ledger (organization_id, idempotency_key, source, rounding_policy, billable_reason, outcome, occurred_at) values ('${A.orgId}', 'forged', 'x', 'x', 'x', 'x', now())`,
          ),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      runInTenant({ organizationId: B.orgId }, async () =>
        await runtimeDb.execute(
          sql.raw(`insert into billing_events (organization_id, provider, provider_event_id, event_type, outcome, payload_digest) values ('${A.orgId}', 'mock', 'forged', 't', 'applied', 'd')`),
        ),
      ),
    ).rejects.toThrow();
    const forged = await db.select().from(usageLedger).where(eq(usageLedger.idempotencyKey, "forged"));
    expect(forged).toHaveLength(0);
  });

  it("the runtime role cannot delete ledger/event rows, truncate billing tables or edit the plan catalog", async () => {
    for (const stmt of ["delete from usage_ledger", "delete from billing_events", "truncate usage_ledger", "truncate subscriptions", "update plans set price_paise = 0"]) {
      await expect(runInTenant({ organizationId: A.orgId }, async () => await runtimeDb.execute(sql.raw(stmt))), stmt).rejects.toThrow();
    }
    expect((await db.select().from(usageLedger).where(eq(usageLedger.organizationId, A.orgId))).length).toBeGreaterThan(0);
  });
});

describe("HTTP: authentication, authorization and forged identity", () => {
  const writes: Array<[string, unknown]> = [
    ["/api/billing/plan-change", { planKey: "business" }],
    ["/api/billing/cancel", {}],
    ["/api/billing/resume", {}],
    ["/api/billing/trial", {}],
    ["/api/billing/usage/reconcile", {}],
  ];

  it("unauthenticated callers get 401 on every billing route", async () => {
    for (const p of ["/api/billing/plans", "/api/billing/overview", "/api/billing/usage"]) {
      expect((await http(null, p)).status, p).toBe(401);
    }
    for (const [p, body] of writes) expect((await http(null, p, { method: "POST", body })).status, p).toBe(401);
  });

  it("AGENT, MANAGER and ADMIN cannot change the plan or the subscription; nothing changes", async () => {
    const before = await subOf(A);
    for (const who of ["agentA", "managerA", "adminA"]) {
      for (const [p, body] of writes) {
        const r = await http(cookies[who], p, { method: "POST", body });
        expect(r.status, `${who} ${p}`).toBe(403);
      }
    }
    const after = await subOf(A);
    expect(after).toMatchObject({ planKey: before.planKey, status: before.status, scheduledPlanKey: null, cancelAtPeriodEnd: false });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("AGENT and MANAGER cannot read usage or the billing overview", async () => {
    for (const who of ["agentA", "managerA"]) {
      expect((await http(cookies[who], "/api/billing/overview")).status).toBe(403);
      expect((await http(cookies[who], "/api/billing/usage")).status).toBe(403);
    }
  });

  it("a forged organizationId (body, query) never selects or changes another tenant", async () => {
    const beforeA = await subOf(A);
    for (const [p, body] of writes) {
      const r = await http(cookies.ownerB, p, { method: "POST", body: { ...(body as object), organizationId: A.orgId } });
      expect(r.status, p).toBe(400);
    }
    const r = await http(cookies.ownerB, `/api/billing/plan-change?organizationId=${A.orgId}`, { method: "POST", body: { planKey: "growth" } });
    expect(r.status).toBe(200);
    const afterA = await subOf(A);
    expect(afterA.scheduledPlanKey).toBeNull();
    expect(afterA.updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    expect((await subOf(B)).scheduledPlanKey).toBe("growth"); // applied to the caller's own organization only
    const usageB = await http(cookies.ownerB, `/api/billing/usage?organizationId=${A.orgId}`);
    expect(usageB.status).toBe(200);
    expect(usageB.body.data).toEqual([]);
  });

  it("B cannot read A's usage rows", async () => {
    const aRows = (await http(cookies.ownerA, "/api/billing/usage")).body.data as any[];
    expect(aRows.length).toBeGreaterThan(0);
    const bRows = (await http(cookies.ownerB, "/api/billing/usage?limit=100&includeSuperseded=true")).body.data as any[];
    const aIds = new Set(aRows.map((r) => r.id));
    expect(bRows.some((r) => aIds.has(r.id))).toBe(false);
  });
});

describe("metering idempotency under retries and concurrency", () => {
  it("20 concurrent duplicate deliveries of one call produce exactly one ledger row", async () => {
    const call = await endedCall(B, agentB, 125);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => meteringEngine.meterCall(B.orgId, call, i % 2 ? "call_lifecycle" : "reconciliation")),
    );
    expect(results.filter((r) => r.status === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(19);
    const rows = await db.select().from(usageLedger).where(and(eq(usageLedger.organizationId, B.orgId), eq(usageLedger.callId, call.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].billableSeconds).toBe(180);
  });

  it("recordCall, reconcile and API reconcile racing together still count a call once", async () => {
    const call = await endedCall(B, agentB, 59);
    await Promise.all([
      ...Array.from({ length: 8 }, () => meteringService.recordCall(sys(B), { callId: call.id })),
      ...Array.from({ length: 6 }, () => meteringEngine.reconcile(B.orgId)),
      ...Array.from({ length: 4 }, () => http(cookies.ownerB, "/api/billing/usage/reconcile", { method: "POST", body: {} })),
    ]);
    const rows = await db.select().from(usageLedger).where(eq(usageLedger.callId, call.id));
    expect(rows).toHaveLength(1);
  });

  it("a tenant cannot meter another tenant's call by id", async () => {
    const call = await endedCall(A, agentA, 30);
    await expect(meteringService.recordCall(sys(B), { callId: call.id })).rejects.toThrow(/not found/i);
    const rows = await db.select().from(usageLedger).where(and(eq(usageLedger.callId, call.id), eq(usageLedger.organizationId, B.orgId)));
    expect(rows).toHaveLength(0);
  });
});

describe("quota enforcement under concurrency", () => {
  async function admitMany(t: TestTenant, agentId: string, n: number, type: "outbound" | "test" = "outbound") {
    return Promise.allSettled(
      Array.from({ length: n }, () => callsService.createCall(sys(t), { agentId, callType: type, counterpartyNumber: "+919000044444" })),
    );
  }
  const live = async (t: TestTenant) =>
    (await db.select().from(calls).where(and(eq(calls.organizationId, t.orgId), inArray(calls.status, ["initiating", "ringing", "in_progress"])))).length;

  it("with a concurrent-call cap of N, 15 parallel admissions admit exactly N", async () => {
    const N = 2;
    await db.update(subscriptions).set({ planKey: "starter", status: "active", limitOverrides: { maxConcurrentCalls: N } }).where(eq(subscriptions.organizationId, B.orgId));
    const free = N - (await live(B));
    expect(free).toBeGreaterThan(0);
    const results = await admitMany(B, agentB, 15);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(free);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect((r.reason as LimitExceededError).code).toBe("CONCURRENT_CALL_LIMIT");
    }
    expect(await live(B)).toBe(N);
  });

  it("a mix of call types shares the same cap (test calls cannot bypass it)", async () => {
    const before = await live(B);
    const results = (await Promise.all([admitMany(B, agentB, 6, "test"), admitMany(B, agentB, 6, "outbound")])).flat();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    expect(await live(B)).toBe(before);
  });

  it("a suspended subscription admits nobody, concurrently or not", async () => {
    await db.update(subscriptions).set({ status: "suspended" }).where(eq(subscriptions.organizationId, B.orgId));
    const before = (await db.select().from(calls).where(eq(calls.organizationId, B.orgId))).length;
    const results = await admitMany(B, agentB, 6);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect((await db.select().from(calls).where(eq(calls.organizationId, B.orgId))).length).toBe(before);
    await db.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.organizationId, B.orgId));
  });

  it("A's cap is independent of B's calls", async () => {
    await db.update(subscriptions).set({ limitOverrides: { maxConcurrentCalls: 1 } }).where(eq(subscriptions.organizationId, A.orgId));
    const free = Math.max(1 - (await live(A)), 0);
    const results = await admitMany(A, agentA, 5);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(free);
  });
});

describe("payment event replay and tenant derivation", () => {
  const provider = createMockPaymentProvider("security-secret-0123456789ab");
  const body = (org: string, id: string, type = "payment_succeeded", planKey = "growth") =>
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

  it("a tampered body or wrong/missing signature is rejected", () => {
    const raw = body(A.orgId, "evt_sig");
    const sig = provider.sign(raw);
    expect(() => provider.verifyWebhook(raw.replace("growth", "business"), { "x-mock-signature": sig })).toThrow();
    expect(() => provider.verifyWebhook(raw, {})).toThrow();
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": "zz" })).toThrow();
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": sig.slice(2) })).toThrow();
    const other = createMockPaymentProvider("another-secret-0123456789ab");
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": other.sign(raw) })).toThrow();
  });

  it("replaying a processed event (same id, even with a different signed body) is a no-op", async () => {
    const first = verify(body(B.orgId, "evt_replay_1", "payment_succeeded", "growth"));
    expect(await paymentEventsService.handleVerified(sys(B), first)).toBe("applied");
    const snapshot = await subOf(B);
    expect(snapshot.planKey).toBe("growth");

    expect(await paymentEventsService.handleVerified(sys(B), first)).toBe("duplicate");
    const upgraded = verify(body(B.orgId, "evt_replay_1", "payment_succeeded", "business"));
    expect(await paymentEventsService.handleVerified(sys(B), upgraded)).toBe("duplicate");
    const after = await subOf(B);
    expect(after.planKey).toBe("growth");
    expect(after.updatedAt.getTime()).toBe(snapshot.updatedAt.getTime());
    expect(await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, "evt_replay_1"))).toHaveLength(1);
  });

  it("an event id already used by another tenant cannot be replayed to change this tenant", async () => {
    const forA = verify(body(A.orgId, "evt_replay_1", "payment_succeeded", "business"));
    const before = await subOf(A);
    expect(await paymentEventsService.handleVerified(sys(A), forA)).toBe("duplicate");
    expect((await subOf(A)).planKey).toBe(before.planKey);
  });

  it("the organization of an event is never taken from the caller context", async () => {
    const forB = verify(body(B.orgId, "evt_ctx_mismatch"));
    await expect(paymentEventsService.handleVerified(sys(A), forB)).rejects.toThrow(/does not belong/i);
    expect(await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, "evt_ctx_mismatch"))).toHaveLength(0);
  });

  it("no HTTP route accepts a payment event", async () => {
    const raw = body(A.orgId, "evt_http");
    for (const p of ["/api/billing/webhook", "/api/billing/webhooks/mock", "/api/webhooks/payments", "/api/billing/events"]) {
      const r = await fetch(`${baseUrl}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mock-signature": provider.sign(raw) },
        body: raw,
      });
      expect([401, 403, 404], p).toContain(r.status);
    }
    expect(await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, "evt_http"))).toHaveLength(0);
  });
});
