import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { adminDb as db } from "../../db/client.js";
import { calls, usageEvents } from "../../db/schema.js";
import { systemContext, userContext } from "../../auth/context.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";
import { usageService } from "./usage.service.js";

let T: TestTenant;

beforeAll(async () => {
  T = await createTenant("UsageType", { modules: [] });
});

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.organizationId, T.orgId));
  await cleanupTenants();
});

async function finishedCall(callType: "outbound" | "inbound" | "test") {
  const startedAt = new Date(Date.now() - 60_000);
  const [call] = await db
    .insert(calls)
    .values({ organizationId: T.orgId, agentId: T.agentId, callType, status: "completed", startedAt, endedAt: new Date() })
    .returning();
  await usageService.recordCallUsage(systemContext(T.orgId, "test"), call.id);
  return call;
}

describe("usage and call type", () => {
  it("records the call type and agent with every event, and keeps test calls out of the totals", async () => {
    const ctx = userContext(T.orgId, T.userId, "OWNER");
    const before = (await usageService.summary(ctx, {})).totals;

    const real = await finishedCall("outbound");
    const inbound = await finishedCall("inbound");
    const test = await finishedCall("test");

    const after = (await usageService.summary(ctx, {})).totals;
    // outbound + inbound count; the test call does not.
    expect(after.calls - before.calls).toBe(2);
    expect(after.callSeconds - before.callSeconds).toBeGreaterThanOrEqual(110);
    expect(after.callSeconds - before.callSeconds).toBeLessThan(130);

    // The test call IS in the ledger (traceable), tagged so it is excluded.
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.callId, test.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.metadata).toMatchObject({ callType: "test", agentId: T.agentId });
    const realRows = await db.select().from(usageEvents).where(eq(usageEvents.callId, real.id));
    for (const r of realRows) expect(r.metadata).toMatchObject({ callType: "outbound", agentId: T.agentId });
    const inboundRows = await db.select().from(usageEvents).where(eq(usageEvents.callId, inbound.id));
    for (const r of inboundRows) expect(r.metadata).toMatchObject({ callType: "inbound" });
  });

  it("the daily series excludes test calls too", async () => {
    const ctx = userContext(T.orgId, T.userId, "OWNER");
    const beforeDaily = await usageService.daily(ctx, {});
    const sum = (d: typeof beforeDaily) => d.data.reduce((n, day) => n + day.calls, 0);
    const base = sum(beforeDaily);
    await finishedCall("test");
    expect(sum(await usageService.daily(ctx, {}))).toBe(base);
    await finishedCall("outbound");
    expect(sum(await usageService.daily(ctx, {}))).toBe(base + 1);
  });
});
