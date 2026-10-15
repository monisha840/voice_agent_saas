/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read untyped JSON responses */
/** Usage ledger: exactly-once recording on finalize, and the tenant-scoped read API. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { calls, usageEvents } from "../../db/schema.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { callsService } from "../calls/calls.service.js";
import { usageService, resolveRange } from "./usage.service.js";
import { conversationsRepository } from "../../test/repos.js";
import { usageRepository } from "../../test/repos.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let ctxA: RequestContext;
const cookies: Record<string, string> = {};

async function get(cookie: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as any };
}

/** A completed call with a 95s duration and 3 AI turns out of 5. */
async function finishedCall(tenant: TestTenant, opts: { timed?: boolean } = {}) {
  const startedAt = new Date(Date.now() - 95_000);
  const [call] = await db
    .insert(calls)
    .values({
      organizationId: tenant.orgId,
      agentId: tenant.agentId,
      leadId: tenant.leadId,
      status: "completed",
      startedAt: opts.timed === false ? null : startedAt,
      endedAt: new Date(startedAt.getTime() + 95_000),
    })
    .returning();
  await conversationsRepository.createForCall({ organizationId: tenant.orgId, callId: call.id });
  const speakers = ["ai", "lead", "ai", "lead", "ai"] as const;
  for (const [i, speaker] of speakers.entries()) {
    await conversationsRepository.appendTurn({
      organizationId: tenant.orgId,
      callId: call.id,
      turn: { speaker, text: `turn ${i}`, timestamp: new Date().toISOString() },
    });
  }
  return call;
}

async function eventsFor(callId: string) {
  return db.select().from(usageEvents).where(eq(usageEvents.callId, callId));
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  ctxA = userContext(A.orgId, A.userId, "OWNER");
  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const agent = await createMember(A.orgId, "AGENT");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies.ownerA = await loginCookie(baseUrl, A.email);
  cookies.ownerB = await loginCookie(baseUrl, B.email);
  cookies.admin = await loginCookie(baseUrl, admin.email);
  cookies.manager = await loginCookie(baseUrl, manager.email);
  cookies.agent = await loginCookie(baseUrl, agent.email);
});

afterAll(async () => {
  await app.close();
  await db.delete(usageEvents).where(eq(usageEvents.organizationId, A.orgId));
  await db.delete(usageEvents).where(eq(usageEvents.organizationId, B.orgId));
  await cleanupTenants();
});

describe("recording on finalize", () => {
  it("records call, call_seconds and ai_turn exactly once, even when finalized repeatedly or concurrently", async () => {
    const call = await finishedCall(A);
    await Promise.all([
      callsService.finalizeCall(ctxA, { callId: call.id }),
      callsService.finalizeCall(ctxA, { callId: call.id }),
    ]);
    await callsService.finalizeCall(ctxA, { callId: call.id });
    await usageService.recordCallUsage(ctxA, call.id); // a direct duplicate is safe too

    const events = await eventsFor(call.id);
    const byType = Object.fromEntries(events.map((e) => [e.type, e]));
    expect(events).toHaveLength(3);
    expect(byType.call.quantity).toBe(1);
    expect(byType.call_seconds.quantity).toBe(95);
    expect(byType.ai_turn.quantity).toBe(3);
    expect(byType.call.dedupeKey).toBe(`call:${call.id}`);
    expect(events.every((e) => e.organizationId === A.orgId)).toBe(true);
  });

  it("skips call_seconds when the call has no start time", async () => {
    const call = await finishedCall(A, { timed: false });
    await callsService.finalizeCall(ctxA, { callId: call.id });
    expect((await eventsFor(call.id)).map((e) => e.type).sort()).toEqual(["ai_turn", "call"]);
  });

  it("never throws (unknown call id)", async () => {
    await expect(usageService.recordCallUsage(ctxA, "00000000-0000-4000-8000-000000000000")).resolves.toBeUndefined();
  });

  it("clamps negative durations to zero", async () => {
    const [call] = await db
      .insert(calls)
      .values({
        organizationId: A.orgId,
        agentId: A.agentId,
        leadId: A.leadId,
        status: "completed",
        startedAt: new Date(),
        endedAt: new Date(Date.now() - 5000),
      })
      .returning();
    await usageService.recordCallUsage(ctxA, call.id);
    const secs = (await eventsFor(call.id)).find((e) => e.type === "call_seconds");
    expect(secs?.quantity).toBe(0);
  });
});

describe("range validation", () => {
  it("defaults to 30 days, treats a date-only `to` as inclusive, and enforces limits", () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const d = resolveRange({}, now);
    expect(d.to).toEqual(now);
    expect(now.getTime() - d.from.getTime()).toBe(30 * 86_400_000);
    expect(resolveRange({ from: "2026-06-01", to: "2026-06-30" }, now).to.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(() => resolveRange({ from: "nope" })).toThrow();
    expect(() => resolveRange({ from: "2026-06-10", to: "2026-06-01" })).toThrow();
    expect(() => resolveRange({ from: "2024-01-01", to: "2026-01-01" })).toThrow();
  });
});

describe("usage API", () => {
  it("summary totals for A include only A, never B", async () => {
    const callB = await finishedCall(B);
    await usageService.recordCallUsage(userContext(B.orgId, B.userId, "OWNER"), callB.id);
    await usageService.recordSiteVisit(ctxA, { id: A.siteVisitId, leadId: A.leadId, projectId: A.projectId });

    const a = (await get(cookies.ownerA, "/api/usage/summary")).body.data;
    const b = (await get(cookies.ownerB, "/api/usage/summary")).body.data;
    // A: three recorded calls (95s+3 turns, no-start+3 turns, clamped 0s+0 turns) and one visit.
    expect(a.totals.calls).toBe(3);
    expect(a.totals.callSeconds).toBe(95);
    expect(a.totals.aiTurns).toBe(6);
    expect(a.totals.siteVisits).toBe(1);
    expect(a.byType.map((r: { type: string }) => r.type).sort()).toEqual(["ai_turn", "call", "call_seconds", "site_visit"]);
    expect(b.totals).toEqual({ calls: 1, callSeconds: 95, aiTurns: 3, siteVisits: 0 });
  });

  it("daily buckets are per UTC day, zero-filled, and organization scoped", async () => {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await usageRepository.record({
      organizationId: A.orgId,
      type: "call",
      quantity: 4,
      dedupeKey: "test:daily-old",
      occurredAt: new Date(`${day}T10:00:00Z`),
    });
    const from = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
    const res = await get(cookies.ownerA, `/api/usage/daily?from=${from}&to=${new Date().toISOString().slice(0, 10)}`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ date: string; calls: number }>;
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.date === day)?.calls).toBe(4);
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(7); // 4 backdated + A's 3 finalized/recorded calls; none of B's
  });

  it("OWNER and ADMIN may read; MANAGER and AGENT get 403", async () => {
    expect((await get(cookies.ownerA, "/api/usage/summary")).status).toBe(200);
    expect((await get(cookies.admin, "/api/usage/summary")).status).toBe(200);
    expect((await get(cookies.admin, "/api/usage/daily")).status).toBe(200);
    for (const who of ["manager", "agent"]) {
      expect((await get(cookies[who], "/api/usage/summary")).status).toBe(403);
      expect((await get(cookies[who], "/api/usage/daily")).status).toBe(403);
    }
    expect((await fetch(`${baseUrl}/api/usage/summary`)).status).toBe(401);
  });

  it("rejects bad dates and over-long ranges with 400", async () => {
    for (const q of ["from=garbage", "to=2026-13-45", "from=2026-06-10&to=2026-06-01", "from=2020-01-01&to=2026-01-01"]) {
      const res = await get(cookies.ownerA, `/api/usage/summary?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    expect((await get(cookies.ownerA, "/api/usage/daily?from=bad")).status).toBe(400);
  });
});
