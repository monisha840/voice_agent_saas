import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb as db } from "../db/client.js";
import { auditLogs, subscriptions } from "../db/schema.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { organizationsRepository } from "../db/repositories/organizations.repository.js";
import { cleanupTenants, createTenant } from "../test/tenants.js";
import { assignSubscription } from "./billing-assign-subscription.js";

afterAll(cleanupTenants);

const OPERATOR = "test-operator";
const ENTERPRISE_LIMITS = JSON.stringify({ maxConcurrentCalls: 25, includedMinutes: 20_000, maxAgents: 40 });

const assign = (input: Parameters<typeof assignSubscription>[0]) => runAsAdmin(() => assignSubscription(input));

async function subscriptionOf(orgId: string) {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId)).limit(1);
  return rows[0] ?? null;
}

async function slugOf(orgId: string) {
  return (await runAsAdmin(() => organizationsRepository.findById({ id: orgId })))!.slug;
}

describe("billing:assign-subscription", () => {
  it("gives an unmanaged organization its first subscription, with the plan's own period, and audits it", async () => {
    const t = await createTenant("S1");
    expect(await subscriptionOf(t.orgId)).toBeNull(); // unmanaged legacy state

    const r = await assign({ org: t.orgId, planKey: "starter", operator: OPERATOR, reason: "PO-1" });
    expect(r).toMatchObject({ created: true, planKey: "starter", status: "active", previousPlanKey: null });
    expect(r.entitlement).toMatchObject({ allowed: true, reason: "OK", includedMinutes: 300, maxConcurrentCalls: 3 });

    const row = (await subscriptionOf(t.orgId))!;
    expect(row.status).toBe("active");
    expect(row.currentPeriodEnd.getTime()).toBeGreaterThan(row.currentPeriodStart.getTime());
    expect(row.trialEndsAt).toBeNull();

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, t.orgId), eq(auditLogs.entityType, "subscription")));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("subscription.created_by_operator");
    expect(audit[0].metadata).toMatchObject({ operator: OPERATOR, reason: "PO-1", plan: "starter" });
  });

  it("starts a trial from the plan's trial_days when the plan has them", async () => {
    const t = await createTenant("S2");
    const r = await assign({ org: await slugOf(t.orgId), planKey: "trial", operator: OPERATOR });
    expect(r.status).toBe("trialing");
    expect(r.trialEndsAt).toBe(r.periodEnd); // a trial's period IS the trial
    const row = (await subscriptionOf(t.orgId))!;
    expect(row.status).toBe("trialing");
    expect(Math.round((row.trialEndsAt!.getTime() - row.currentPeriodStart.getTime()) / 86_400_000)).toBe(14);
  });

  it("changes the plan of an organization that already has a subscription and clears a pending plan request", async () => {
    const t = await createTenant("S3");
    await assign({ org: t.orgId, planKey: "trial", operator: OPERATOR });
    await db.update(subscriptions).set({ scheduledPlanKey: "growth" }).where(eq(subscriptions.organizationId, t.orgId));

    const r = await assign({ org: t.orgId, planKey: "growth", operator: OPERATOR });
    expect(r).toMatchObject({ created: false, previousPlanKey: "trial", planKey: "growth", status: "active" });
    const row = (await subscriptionOf(t.orgId))!;
    expect(row.scheduledPlanKey).toBeNull();
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(row.canceledAt).toBeNull();

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, t.orgId), eq(auditLogs.action, "subscription.plan_assigned_by_operator")));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ previousPlan: "trial", plan: "growth", operator: OPERATOR });
  });

  it("refuses an Enterprise plan with no negotiated limits, and writes nothing", async () => {
    const t = await createTenant("S4");
    await expect(assign({ org: t.orgId, planKey: "enterprise", operator: OPERATOR })).rejects.toThrow(/LIMITS_NOT_CONFIGURED/);
    expect(await subscriptionOf(t.orgId)).toBeNull();
    // Same refusal with limits that still leave no included minutes.
    await expect(
      assign({ org: t.orgId, planKey: "enterprise", limitOverrides: JSON.stringify({ maxConcurrentCalls: 5, includedMinutes: 0 }), operator: OPERATOR }),
    ).rejects.toThrow(/MINUTES_EXHAUSTED/);
    expect(await subscriptionOf(t.orgId)).toBeNull();
  });

  it("accepts Enterprise with negotiated limits and reports the entitlements they produce", async () => {
    const t = await createTenant("S5");
    const r = await assign({ org: t.orgId, planKey: "enterprise", limitOverrides: ENTERPRISE_LIMITS, periodDays: 365, operator: OPERATOR });
    expect(r.entitlement).toMatchObject({ allowed: true, reason: "OK", includedMinutes: 20_000, maxConcurrentCalls: 25 });
    expect(Math.round((new Date(r.periodEnd).getTime() - new Date(r.periodStart).getTime()) / 86_400_000)).toBe(365);
    expect((await subscriptionOf(t.orgId))!.limitOverrides).toMatchObject({ maxConcurrentCalls: 25, includedMinutes: 20_000, maxAgents: 40 });
  });

  it("keeps negotiated overrides across a plan change unless they are given, and clears them on '{}'", async () => {
    const t = await createTenant("S6");
    await assign({ org: t.orgId, planKey: "enterprise", limitOverrides: ENTERPRISE_LIMITS, operator: OPERATOR });

    const kept = await assign({ org: t.orgId, planKey: "growth", operator: OPERATOR });
    expect(kept.limitOverrides).toMatchObject({ maxConcurrentCalls: 25, includedMinutes: 20_000 });
    expect(kept.entitlement.includedMinutes).toBe(20_000);

    const cleared = await assign({ org: t.orgId, planKey: "growth", limitOverrides: "{}", operator: OPERATOR });
    expect(cleared.limitOverrides).toEqual({});
    expect(cleared.entitlement).toMatchObject({ includedMinutes: 2000, maxConcurrentCalls: 10 }); // back to the plan's own
  });

  it("validates the inputs: organization, plan key from the table, status and overrides", async () => {
    const t = await createTenant("S7");
    await expect(assign({ org: "", planKey: "starter", operator: OPERATOR })).rejects.toThrow(/ORG is required/);
    await expect(assign({ org: t.orgId, planKey: "", operator: OPERATOR })).rejects.toThrow(/PLAN is required/);
    await expect(assign({ org: "no-such-org", planKey: "starter", operator: OPERATOR })).rejects.toThrow(/No organization with slug or id/);
    await expect(assign({ org: t.orgId, planKey: "platinum", operator: OPERATOR })).rejects.toThrow(/No plan with key "platinum". Active plans: /);
    await expect(assign({ org: t.orgId, planKey: "starter", status: "suspended", operator: OPERATOR })).rejects.toThrow(/STATUS must be one of/);
    await expect(assign({ org: t.orgId, planKey: "starter", status: "trialing", operator: OPERATOR })).rejects.toThrow(/needs trial days/);
    await expect(assign({ org: t.orgId, planKey: "starter", limitOverrides: "not json", operator: OPERATOR })).rejects.toThrow(/not valid JSON/);
    await expect(assign({ org: t.orgId, planKey: "starter", limitOverrides: '{"maxAgents":"many"}', operator: OPERATOR })).rejects.toThrow(
      /not a valid override set/,
    );
    expect(await subscriptionOf(t.orgId)).toBeNull();
  });
});
