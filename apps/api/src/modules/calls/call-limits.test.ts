/**
 * Cost and abuse protection: per-organization concurrent-call limit, daily call quota, monthly call-seconds quota,
 * atomic under parallel requests, tenant-aware, fail-safe, and never touching calls that are already running.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { db } from "../../db/client.js";
import { calls } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { usageRepository } from "../../db/repositories/usage.repository.js";
import { LimitExceededError, ServiceUnavailableError } from "../../shared/errors.js";
import { lifecycle } from "../../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { CapturingProvider, httpClient, relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { callsService } from "./calls.service.js";
import { callLimits } from "./call-limits.js";

relaxRateLimits();

const ENV = ["MAX_CONCURRENT_CALLS_PER_ORG", "QUOTA_CALLS_PER_ORG_PER_DAY", "QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH"] as const;

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let B: TestTenant;
let agentA = "";
let agentB = "";
let cookieA = "";

const ctx = (t: TestTenant) => systemContext(t.orgId, "test");
const place = (t: TestTenant, agentId: string) =>
  callsService.createCall(ctx(t), { agentId, callType: "outbound", counterpartyNumber: "+919000088888" });
const activeCount = async (orgId: string) =>
  (await db.select().from(calls).where(and(eq(calls.organizationId, orgId), inArray(calls.status, ["initiating", "ringing", "in_progress"])))).length;
const generic = (orgId: string, name: string) =>
  createDefaultAgent(orgId, { name, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });

beforeAll(async () => {
  A = await createTenant("LIM_A");
  B = await createTenant("LIM_B");
  agentA = (await generic(A.orgId, "A agent")).id;
  agentB = (await generic(B.orgId, "B agent")).id;
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  cookieA = await loginCookie(baseUrl, A.email);
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(() => {
  vi.restoreAllMocks();
  lifecycle.reset();
  setTelephonyProvider(null);
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
  process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
  process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
});

describe("concurrent-call limit", () => {
  it("is per organization: one tenant at its limit does not block another", async () => {
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "3";
    for (let i = 0; i < 3; i++) await place(A, agentA);
    const refused = await place(A, agentA).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LimitExceededError);
    expect((refused as LimitExceededError).code).toBe("CONCURRENT_CALL_LIMIT");
    expect(await activeCount(A.orgId)).toBe(3); // the refused call created nothing

    await expect(place(B, agentB)).resolves.toMatchObject({ organizationId: B.orgId }); // B is unaffected
  });

  it("a call that ends frees its slot", async () => {
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = String((await activeCount(A.orgId)) + 1);
    const call = await place(A, agentA);
    await expect(place(A, agentA)).rejects.toBeInstanceOf(LimitExceededError);
    await callsRepository.transitionToTerminal({ organizationId: A.orgId, id: call.id, status: "completed", endedAt: new Date() });
    await expect(place(A, agentA)).resolves.toBeTruthy();
  });

  it("is atomic: parallel requests cannot all slip under the limit", async () => {
    const C = await createTenant("LIM_C");
    const agentC = (await generic(C.orgId, "C agent")).id;
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "3";
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => place(C, agentC)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(12);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LimitExceededError);
    expect(await activeCount(C.orgId)).toBe(3);
  });

  it("0 means unlimited", async () => {
    const D = await createTenant("LIM_D");
    const agentD = (await generic(D.orgId, "D agent")).id;
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "0";
    for (let i = 0; i < 6; i++) await place(D, agentD);
    expect(await activeCount(D.orgId)).toBe(6);
  });

  it("a malformed value falls back to the safe default instead of disabling the limit", async () => {
    const E = await createTenant("LIM_E");
    const agentE = (await generic(E.orgId, "E agent")).id;
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "oops";
    const limits = await callLimits.limitsFor(E.orgId);
    expect(limits.maxConcurrentCallsPerOrg).toBe(10);
    for (let i = 0; i < 10; i++) await place(E, agentE);
    await expect(place(E, agentE)).rejects.toBeInstanceOf(LimitExceededError);
  });
});

describe("running calls when a limit changes", () => {
  it("lowering the limit never touches calls already in progress; it only refuses new ones", async () => {
    const F = await createTenant("LIM_F");
    const agentF = (await generic(F.orgId, "F agent")).id;
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "5";
    const running: Awaited<ReturnType<typeof place>>[] = [];
    for (let i = 0; i < 4; i++) running.push(await place(F, agentF));
    await callsRepository.updateStatus({ organizationId: F.orgId, id: running[0].id, status: "in_progress", startedAt: new Date() });

    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "2"; // lowered below the 4 that are live
    expect(await activeCount(F.orgId)).toBe(4); // nothing was terminated or altered
    const rows = await db.select().from(calls).where(inArray(calls.id, running.map((c) => c.id)));
    expect(rows.find((r) => r.id === running[0].id)?.status).toBe("in_progress");
    await expect(place(F, agentF)).rejects.toBeInstanceOf(LimitExceededError);

    // As calls end the count falls; new calls are allowed again only once it is under the new limit.
    for (const c of running.slice(0, 3)) await callsRepository.transitionToTerminal({ organizationId: F.orgId, id: c.id, status: "completed", endedAt: new Date() });
    expect(await activeCount(F.orgId)).toBe(1);
    await expect(place(F, agentF)).resolves.toBeTruthy();
    await expect(place(F, agentF)).rejects.toBeInstanceOf(LimitExceededError);
  });
});

describe("daily call quota", () => {
  it("counts every call created in the last 24 hours and then refuses; older calls do not count", async () => {
    const G = await createTenant("LIM_G");
    const agentG = (await generic(G.orgId, "G agent")).id;
    const existing = (await db.select().from(calls).where(eq(calls.organizationId, G.orgId))).length;
    process.env.QUOTA_CALLS_PER_ORG_PER_DAY = String(existing + 2);
    const first = await place(G, agentG);
    await place(G, agentG);
    const refused = await place(G, agentG).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LimitExceededError);
    expect((refused as LimitExceededError).code).toBe("DAILY_CALL_QUOTA");

    // Age one call past 24 hours: it leaves the window and a slot opens up.
    await db.update(calls).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(calls.id, first.id));
    await expect(place(G, agentG)).resolves.toBeTruthy();
  });
});

describe("monthly call-seconds quota", () => {
  const record = (orgId: string, quantity: number, extra: { callType?: string; occurredAt?: Date } = {}) =>
    usageRepository.record({
      organizationId: orgId,
      type: "call_seconds",
      quantity,
      dedupeKey: `quota-test-${Math.random().toString(36).slice(2)}`,
      metadata: { callType: extra.callType ?? "outbound" },
      occurredAt: extra.occurredAt,
    });

  it("refuses new calls once the organization has used its month of call seconds; other tenants are unaffected", async () => {
    const H = await createTenant("LIM_H");
    const agentH = (await generic(H.orgId, "H agent")).id;
    process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "100";
    await record(H.orgId, 60);
    await expect(place(H, agentH)).resolves.toBeTruthy();
    await record(H.orgId, 40);
    const refused = await place(H, agentH).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LimitExceededError);
    expect((refused as LimitExceededError).code).toBe("MONTHLY_CALL_SECONDS_QUOTA");
    await expect(place(B, agentB)).resolves.toBeTruthy(); // B has used nothing
  });

  it("test calls and last month's usage do not count", async () => {
    const I = await createTenant("LIM_I");
    const agentI = (await generic(I.orgId, "I agent")).id;
    process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "100";
    await record(I.orgId, 500, { callType: "test" });
    await record(I.orgId, 500, { occurredAt: new Date(Date.now() - 62 * 24 * 3600_000) });
    await expect(place(I, agentI)).resolves.toBeTruthy();
  });
});

describe("over HTTP", () => {
  it("POST /api/calls over the limit is 429 with a code and Retry-After, creates nothing and never dials", async () => {
    const provider = new CapturingProvider();
    setTelephonyProvider(provider);
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = String(await activeCount(A.orgId));
    const before = (await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length;

    const res = await fetch(`${baseUrl}/api/calls`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ agentId: agentA, callType: "outbound", toNumber: "+919000077777" }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "CONCURRENT_CALL_LIMIT" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(provider.calls).toHaveLength(0);
    expect((await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length).toBe(before);
  });

  it("a test call with no number is limited too (simulated calls are not a free pass)", async () => {
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = String(await activeCount(A.orgId));
    const res = await http(cookieA, "POST", "/api/calls", { agentId: agentA, callType: "test" });
    expect(res.status).toBe(429);
  });
});

describe("fail-safe", () => {
  it("a draining server refuses new calls with 503 SHUTTING_DOWN and creates nothing", async () => {
    const provider = new CapturingProvider();
    setTelephonyProvider(provider);
    lifecycle.beginDrain();
    const before = (await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length;
    await expect(place(A, agentA)).rejects.toBeInstanceOf(ServiceUnavailableError);

    const res = await http(cookieA, "POST", "/api/calls", { agentId: agentA, callType: "outbound", toNumber: "+919000066666" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "SHUTTING_DOWN" });
    expect(provider.calls).toHaveLength(0);
    expect((await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length).toBe(before);
  });

  it("if the limit check itself fails the call is NOT created (fail closed, never fail open)", async () => {
    const provider = new CapturingProvider();
    setTelephonyProvider(provider);
    vi.spyOn(callsRepository, "createWithinLimits").mockRejectedValue(new Error("could not count active calls"));
    const before = (await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length;
    const res = await http(cookieA, "POST", "/api/calls", { agentId: agentA, callType: "outbound", toNumber: "+919000055555" });
    expect(res.status).toBe(500);
    expect(provider.calls).toHaveLength(0);
    expect((await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length).toBe(before);
  });

  it("the env defaults are finite so a fresh deployment is protected without any configuration", async () => {
    for (const k of ENV) delete process.env[k];
    const l = await callLimits.limitsFor(A.orgId);
    expect(l.maxConcurrentCallsPerOrg).toBeGreaterThan(0);
    expect(l.maxCallsPerOrgPerDay).toBeGreaterThan(0);
  });
});
