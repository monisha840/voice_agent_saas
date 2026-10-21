/**
 * Security workstream 1 regression tests (real PostgreSQL, restricted runtime role):
 *  - concurrency-safe included-minute admission and its documented overshoot,
 *  - narrowed grants on billing_events / usage_ledger (migration 0022),
 *  - payment-event validation (periodEnd <= periodStart), ordering, duplicates, replay, cross-tenant,
 *  - usage reliability for interrupted calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql, db as runtimeDb } from "../../db/client.js";
import { runInTenant } from "../../db/tenant-context.js";
import { billingEvents, calls, subscriptions, usageLedger } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { LimitExceededError, ValidationError } from "../../shared/errors.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../test/tenants.js";
import { callsService } from "../calls/calls.service.js";
import { meteringEngine } from "./metering-engine.js";
import { paymentEventsService } from "./payment-events.service.js";
import { createMockPaymentProvider, type VerifiedPaymentEvent } from "./payment-provider.js";
import { TEST_RUNTIME_ROLE } from "../../test/test-database.js";

let M: TestTenant; // minutes admission
let P: TestTenant; // payment events
let Q: TestTenant; // second tenant for cross-tenant events
let R: TestTenant; // interrupted calls / boundary admission
let U: TestTenant; // unmanaged (no subscription)
let agentM = "";
let agentR = "";
let agentP = "";
const day = 86_400_000;
const orgIds = () => [M.orgId, P.orgId, Q.orgId, R.orgId, U.orgId];
const sys = (t: TestTenant) => systemContext(t.orgId, "test");
const mkAgent = (t: TestTenant) =>
  createDefaultAgent(t.orgId, { name: "x", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });

async function giveSub(t: TestTenant, v: Partial<typeof subscriptions.$inferInsert> & { planKey: string }) {
  const now = Date.now();
  await db.insert(subscriptions).values({
    organizationId: t.orgId,
    status: "active",
    currentPeriodStart: new Date(now - 5 * day),
    currentPeriodEnd: new Date(now + 25 * day),
    ...v,
  });
}
const subOf = async (t: TestTenant) => (await db.select().from(subscriptions).where(eq(subscriptions.organizationId, t.orgId)))[0];
const setOverrides = (t: TestTenant, o: Record<string, number>) =>
  db.update(subscriptions).set({ limitOverrides: o }).where(eq(subscriptions.organizationId, t.orgId));

beforeAll(async () => {
  M = await createTenant("WS1_M", { modules: [] });
  P = await createTenant("WS1_P", { modules: [] });
  Q = await createTenant("WS1_Q", { modules: [] });
  R = await createTenant("WS1_R", { modules: [] });
  U = await createTenant("WS1_U", { modules: [] });
  agentM = (await mkAgent(M)).id;
  agentR = (await mkAgent(R)).id;
  agentP = (await mkAgent(P)).id;
  await giveSub(M, { planKey: "starter", limitOverrides: { includedMinutes: 10, maxConcurrentCalls: 50 } });
  await giveSub(P, { planKey: "starter" });
  await giveSub(Q, { planKey: "starter" });
  await giveSub(R, { planKey: "starter", limitOverrides: { includedMinutes: 100_000, maxConcurrentCalls: 50 } });
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
  process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
  process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
});

afterAll(async () => {
  setTelephonyProvider(null);
  delete process.env.BILLING_ADMISSION_RESERVE_SECONDS;
  await adminSql!.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe("delete from usage_ledger where organization_id = any($1::uuid[])", [orgIds()]);
  });
  await db.delete(billingEvents).where(inArray(billingEvents.organizationId, orgIds()));
  await db.delete(subscriptions).where(inArray(subscriptions.organizationId, orgIds()));
  await cleanupTenants();
});

afterEach(() => vi.restoreAllMocks());

describe("included-minute admission is atomic (reserve in-flight calls, then settle)", () => {
  const admit = (t: TestTenant, agentId: string, n: number) =>
    Promise.allSettled(
      Array.from({ length: n }, () => callsService.createCall(sys(t), { agentId, callType: "outbound", counterpartyNumber: "+919000055555" })),
    );

  it("30 parallel admissions against 600 s with a 60 s reservation admit exactly 10; the rest are MINUTES_EXHAUSTED", async () => {
    delete process.env.BILLING_ADMISSION_RESERVE_SECONDS; // default: one rounding increment = 60 s
    const rowsBefore = (await db.select().from(calls).where(eq(calls.organizationId, M.orgId))).length;
    const results = await admit(M, agentM, 30);
    // in-flight 0..9 reserve 0..540 s (< 600 s); the 11th sees 600 s >= 600 s
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect((r.reason as LimitExceededError).code).toBe("MINUTES_EXHAUSTED");
    }
    const rows = await db.select().from(calls).where(eq(calls.organizationId, M.orgId));
    expect(rows.length - rowsBefore).toBe(10);
  });

  it("calls that end settle to their real usage: the allowance is then used up and nothing more is admitted", async () => {
    await db
      .update(calls)
      .set({ status: "completed", startedAt: new Date(Date.now() - 30_000), endedAt: new Date() })
      .where(eq(calls.organizationId, M.orgId));
    await meteringEngine.reconcileAll(M.orgId);
    const before = (await db.select().from(calls).where(eq(calls.organizationId, M.orgId))).length;
    const refused = await admit(M, agentM, 5);
    expect(refused.every((r) => r.status === "rejected")).toBe(true);
    expect((await db.select().from(calls).where(eq(calls.organizationId, M.orgId))).length).toBe(before);
  });

  it("near the boundary (540 s of 600 s used) exactly one of 12 parallel calls is admitted", async () => {
    await setOverrides(R, { includedMinutes: 10, maxConcurrentCalls: 50 });
    const start = new Date(Date.now() - 600_000);
    await db
      .insert(calls)
      .values({ organizationId: R.orgId, agentId: agentR, status: "completed", callType: "outbound", startedAt: start, endedAt: new Date(start.getTime() + 540_000) });
    const results = await admit(R, agentR, 12);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await setOverrides(R, { includedMinutes: 100_000, maxConcurrentCalls: 50 });
  });

  it("a larger reservation tightens the bound (120 s reserve: 5 of 600 s) and 0 disables reservation", async () => {
    await db.delete(calls).where(eq(calls.organizationId, P.orgId));
    await setOverrides(P, { includedMinutes: 10, maxConcurrentCalls: 50 });
    process.env.BILLING_ADMISSION_RESERVE_SECONDS = "120";
    expect((await admit(P, agentP, 20)).filter((r) => r.status === "fulfilled")).toHaveLength(5);
    // reserve 0: only metered usage counts, so with nothing metered every in-flight admission passes (up to the cap of 50)
    await db.update(calls).set({ status: "failed", endedAt: new Date() }).where(eq(calls.organizationId, P.orgId));
    process.env.BILLING_ADMISSION_RESERVE_SECONDS = "0";
    expect((await admit(P, agentP, 8)).filter((r) => r.status === "fulfilled")).toHaveLength(8);
    delete process.env.BILLING_ADMISSION_RESERVE_SECONDS;
    await setOverrides(P, {});
  });
});

describe("grants on billing_events and usage_ledger (migration 0022)", () => {
  const privTable = async (t: string, p: string) =>
    ((await adminSql!`select has_table_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${p}) as ok`)[0] as { ok: boolean }).ok;
  const privCol = async (t: string, c: string, p: string) =>
    ((await adminSql!`select has_column_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${c}, ${p}) as ok`)[0] as { ok: boolean }).ok;
  const columns = async (t: string) =>
    ((await adminSql!`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${t}`) as unknown as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );

  it("catalog: no UPDATE on billing_events, UPDATE only on usage_ledger.state, no DELETE/TRUNCATE on either", async () => {
    expect(await privTable("billing_events", "INSERT")).toBe(true);
    expect(await privTable("billing_events", "SELECT")).toBe(true);
    for (const p of ["DELETE", "TRUNCATE"]) {
      expect(await privTable("billing_events", p), `billing_events ${p}`).toBe(false);
      expect(await privTable("usage_ledger", p), `usage_ledger ${p}`).toBe(false);
    }
    for (const c of await columns("usage_ledger")) {
      expect(await privCol("usage_ledger", c, "UPDATE"), `usage_ledger.${c}`).toBe(c === "state");
    }
    for (const c of await columns("billing_events")) {
      expect(await privCol("billing_events", c, "UPDATE"), `billing_events.${c}`).toBe(false);
    }
  });

  it("runtime role cannot rewrite event or ledger content; superseding (state) still works", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: Q.orgId, agentId: (await mkAgent(Q)).id, status: "completed", callType: "outbound", startedAt: new Date(Date.now() - 90_000), endedAt: new Date() })
      .returning();
    const m = await meteringEngine.meterCall(Q.orgId, call, "call_lifecycle");
    if (m.status === "not_terminal") throw new Error("expected a ledger entry");
    await db.insert(billingEvents).values({
      organizationId: Q.orgId,
      provider: "mock",
      providerEventId: `evt_grant_${randomUUID()}`,
      eventType: "payment_failed",
      outcome: "ignored",
      payloadDigest: "d".repeat(64),
    });
    for (const stmt of [
      `update billing_events set outcome = 'applied'`,
      `update usage_ledger set billable_seconds = 0`,
      `update usage_ledger set organization_id = organization_id`,
      `update usage_ledger set idempotency_key = 'x'`,
    ]) {
      await expect(runInTenant({ organizationId: Q.orgId }, async () => await runtimeDb.execute(sql.raw(stmt))), stmt).rejects.toThrow();
    }
    const corrected = await meteringEngine.correct(Q.orgId, {
      ledgerId: m.entry.id,
      billableSeconds: 60,
      reason: "grant test",
      clientKey: `ws1-${randomUUID()}`,
      correctedBy: "test",
    });
    expect(corrected.supersedesId).toBe(m.entry.id);
    const [orig] = await db.select().from(usageLedger).where(eq(usageLedger.id, m.entry.id));
    expect(orig.state).toBe("superseded");
  });
});

describe("payment events: validation, ordering, duplicates, replay, cross-tenant", () => {
  const provider = createMockPaymentProvider("ws1-secret-0123456789abcdef");
  const ev = (org: string, id: string, over: Partial<VerifiedPaymentEvent> = {}): VerifiedPaymentEvent => ({
    provider: "mock",
    eventId: id,
    type: "payment_succeeded",
    organizationId: org,
    planKey: "growth",
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 30 * day),
    occurredAt: new Date(),
    payloadDigest: "a".repeat(64),
    ...over,
  });
  const failure = (org: string, id: string, occurredAt: Date) =>
    ev(org, id, { type: "payment_failed", planKey: undefined, periodStart: undefined, periodEnd: undefined, occurredAt });
  const recorded = async (id: string) => (await db.select().from(billingEvents).where(eq(billingEvents.providerEventId, id))).length;

  it("periodEnd <= periodStart is a ValidationError (not a 500/CHECK violation) and is not recorded", async () => {
    const t = new Date(Date.now() + day);
    for (const [id, end] of [
      ["evt_ws1_eq", t],
      ["evt_ws1_lt", new Date(t.getTime() - 1000)],
    ] as const) {
      const before = await subOf(P);
      await expect(paymentEventsService.handleVerified(sys(P), ev(P.orgId, id, { periodStart: t, periodEnd: end }))).rejects.toBeInstanceOf(ValidationError);
      expect(await recorded(id)).toBe(0);
      expect((await subOf(P)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    }
    // invalid even when the organization has no subscription (validated before any lookup or write)
    await expect(paymentEventsService.handleVerified(sys(U), ev(U.orgId, "evt_ws1_nosub_bad", { periodStart: t, periodEnd: t }))).rejects.toBeInstanceOf(ValidationError);
    expect(await recorded("evt_ws1_nosub_bad")).toBe(0);
  });

  it("the signed-payload boundary rejects an inverted period as a ValidationError, after the signature check", () => {
    const t = new Date(Date.now() + day);
    const raw = JSON.stringify({
      id: "evt_ws1_raw",
      type: "payment_succeeded",
      organizationId: P.orgId,
      planKey: "growth",
      periodStart: t.toISOString(),
      periodEnd: new Date(t.getTime() - 1).toISOString(),
      occurredAt: new Date().toISOString(),
    });
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": provider.sign(raw) })).toThrow(ValidationError);
    expect(() => provider.verifyWebhook(raw, { "x-mock-signature": "00" })).toThrow(/signature/i);
  });

  it("applies a newer payment, then treats an older cycle delivered late as stale (no change, recorded once)", async () => {
    const start = new Date(Date.now() - 1000);
    const newer = ev(P.orgId, "evt_ws1_new", { periodStart: start, periodEnd: new Date(start.getTime() + 30 * day), occurredAt: start });
    expect(await paymentEventsService.handleVerified(sys(P), newer)).toBe("applied");
    const after = await subOf(P);
    expect(after).toMatchObject({ status: "active", planKey: "growth" });

    const olderStart = new Date(start.getTime() - 30 * day);
    const older = ev(P.orgId, "evt_ws1_old", { planKey: "business", periodStart: olderStart, periodEnd: start, occurredAt: olderStart });
    expect(await paymentEventsService.handleVerified(sys(P), older)).toBe("stale");
    expect(await paymentEventsService.handleVerified(sys(P), older)).toBe("duplicate");
    const unchanged = await subOf(P);
    expect(unchanged.planKey).toBe("growth");
    expect(unchanged.updatedAt.getTime()).toBe(after.updatedAt.getTime());
    expect(await recorded("evt_ws1_old")).toBe(1);
  });

  it("a failure that predates the applied renewal is stale; a fresh one is applied", async () => {
    const sub = await subOf(P);
    expect(await paymentEventsService.handleVerified(sys(P), failure(P.orgId, "evt_ws1_fail_old", new Date(sub.currentPeriodStart.getTime() - 60_000)))).toBe("stale");
    expect((await subOf(P)).status).toBe("active");
    expect(await paymentEventsService.handleVerified(sys(P), failure(P.orgId, "evt_ws1_fail_new", new Date()))).toBe("applied");
    expect((await subOf(P)).status).toBe("past_due");
  });

  it("10 concurrent deliveries of one event apply once and record once", async () => {
    const start = new Date(Date.now() - 500);
    const e = ev(P.orgId, "evt_ws1_dup", { planKey: "business", periodStart: start, periodEnd: new Date(start.getTime() + 30 * day), occurredAt: start });
    const results = await Promise.all(Array.from({ length: 10 }, () => paymentEventsService.handleVerified(sys(P), e)));
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.every((r) => r === "applied" || r === "duplicate" || r === "conflict")).toBe(true);
    expect(await recorded("evt_ws1_dup")).toBe(1);
  });

  it("cross-tenant: an event for Q cannot be applied through P's scope, and Q is untouched", async () => {
    const before = await subOf(Q);
    await expect(paymentEventsService.handleVerified(sys(P), ev(Q.orgId, "evt_ws1_cross"))).rejects.toThrow(/does not belong/i);
    expect(await recorded("evt_ws1_cross")).toBe(0);
    expect((await subOf(Q)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("an event for an organization without a subscription is recorded as ignored and changes nothing", async () => {
    expect(await paymentEventsService.handleVerified(sys(U), ev(U.orgId, "evt_ws1_nosub_ok"))).toBe("ignored");
    expect(await paymentEventsService.handleVerified(sys(U), ev(U.orgId, "evt_ws1_nosub_ok"))).toBe("duplicate");
    expect(await db.select().from(subscriptions).where(eq(subscriptions.organizationId, U.orgId))).toHaveLength(0);
  });
});

describe("usage reliability for interrupted calls", () => {
  const ledger = (callId: string) => db.select().from(usageLedger).where(eq(usageLedger.callId, callId));

  it("an abruptly dropped call is closed by the reaper and metered exactly once, however often reaper, stream end and reconcile run", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: R.orgId, agentId: agentR, status: "in_progress", callType: "outbound", startedAt: new Date(Date.now() - 5 * 60_000) })
      .returning();
    expect(await ledger(call.id)).toHaveLength(0); // not metered while it still looks live
    await callsService.reapStaleCalls({ pendingMs: 0, inProgressMs: 0 });
    await callsService.reapStaleCalls({ pendingMs: 0, inProgressMs: 0 });
    await Promise.all([meteringEngine.reconcileAll(R.orgId), meteringEngine.reconcileAll(R.orgId)]);
    await callsService.endFromStream({ callId: call.id, outcome: "completed" }); // late stream end after the reaper
    const rows = await ledger(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("final");
    expect(rows[0].billableSeconds).toBeGreaterThanOrEqual(300);
  });

  it("a connected call that failed is billed once; repeated failure signals add nothing", async () => {
    const [call] = await db
      .insert(calls)
      .values({ organizationId: R.orgId, agentId: agentR, status: "in_progress", callType: "outbound", startedAt: new Date(Date.now() - 45_000) })
      .returning();
    await Promise.all([callsService.endFromStream({ callId: call.id, outcome: "failed" }), callsService.endFromStream({ callId: call.id, outcome: "failed" })]);
    const rows = await ledger(call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].billableSeconds).toBe(60);
  });

  it("an answered call whose end time never arrived is pending (0), then finalized once when the end is known", async () => {
    const startedAt = new Date(Date.now() - 200_000);
    const [call] = await db
      .insert(calls)
      .values({ organizationId: R.orgId, agentId: agentR, status: "failed", callType: "outbound", startedAt })
      .returning();
    await meteringEngine.reconcileAll(R.orgId);
    const first = await ledger(call.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ state: "pending", billableSeconds: 0, billableReason: "interrupted" });
    await db.update(calls).set({ endedAt: new Date(startedAt.getTime() + 120_000) }).where(eq(calls.id, call.id));
    await meteringEngine.reconcileAll(R.orgId);
    await meteringEngine.reconcileAll(R.orgId);
    const all = await ledger(call.id);
    expect(all.filter((r) => r.state !== "superseded")).toHaveLength(1);
    expect(all.find((r) => r.state === "final")?.billableSeconds).toBe(120);
  });
});

describe("seeded plan catalog vs the enforcement matrix", () => {
  it("every entitlement key stored in plans.entitlements is listed in ENTITLEMENT_ENFORCEMENT", async () => {
    const { ENTITLEMENT_ENFORCEMENT } = await import("./plan-types.js");
    const rows = (await adminSql!`select key, entitlements from plans`) as unknown as Array<{ key: string; entitlements: Record<string, unknown> }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const k of Object.keys(r.entitlements)) expect(Object.keys(ENTITLEMENT_ENFORCEMENT), `${r.key}.${k}`).toContain(k);
    }
  });

  it("migration 0025 left no never-implemented entitlement advertised in any plan row", async () => {
    const { REMOVED_ENTITLEMENTS } = await import("./plan-types.js");
    const rows = (await adminSql!`select key, entitlements from plans order by sort_order`) as unknown as Array<{
      key: string;
      entitlements: Record<string, unknown>;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const dead of REMOVED_ENTITLEMENTS) expect(Object.keys(r.entitlements), `${r.key}.${dead}`).not.toContain(dead);
    // the enforced seat/concurrency caps the 0020 triggers read are still there (0025 is not allowed to widen anything)
    const starter = rows.find((r) => r.key === "starter")!;
    expect(starter.entitlements).toEqual({ maxConcurrentCalls: 3, maxAgents: 3, maxTeamMembers: 5 });
  });

  it("re-running migration 0025 is a no-op (idempotent) and never touches the enforced keys", async () => {
    const sqlText = readFileSync(fileURLToPath(new URL("../../db/migrations/0025_drop_unenforced_entitlements.sql", import.meta.url)), "utf8");
    const before = (await adminSql!`select md5(string_agg(key || ':' || entitlements::text, '|' order by key)) d from plans`)[0].d as string;
    for (let i = 0; i < 2; i++) await adminSql!.unsafe(sqlText.replace(/--> statement-breakpoint/g, ""));
    expect((await adminSql!`select md5(string_agg(key || ':' || entitlements::text, '|' order by key)) d from plans`)[0].d).toBe(before);
  });
});
