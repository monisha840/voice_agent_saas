/**
 * Pure logic: subscription state machine, metering rules, rounding, payment-provider signature verification.
 * No database involved (the real-PostgreSQL behaviour is in billing.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { applyEvent, effectiveStatus, InvalidTransitionError, type SubscriptionState } from "./subscription-state.js";
import { computeBillable, roundUp } from "./metering.js";
import { getBillingPolicy } from "./billing-policy.js";
import { createMockPaymentProvider, WebhookVerificationError } from "./payment-provider.js";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const trial: SubscriptionState = {
  status: "trialing",
  planKey: "trial",
  trialEndsAt: at(14 * DAY),
  currentPeriodStart: T0,
  currentPeriodEnd: at(14 * DAY),
  cancelAtPeriodEnd: false,
  canceledAt: null,
};
const active: SubscriptionState = { ...trial, status: "active", planKey: "starter", trialEndsAt: null, currentPeriodEnd: at(30 * DAY) };

describe("subscription state machine", () => {
  it("a trial is trialing until its end, then expired (derived, without a write)", () => {
    expect(effectiveStatus(trial, at(14 * DAY - 1), 3).status).toBe("trialing");
    expect(effectiveStatus(trial, at(14 * DAY), 3)).toEqual({ status: "expired", derivedFrom: "trialing" });
  });

  it("an active period that ends with no verified renewal goes past_due, then suspended after the grace window", () => {
    expect(effectiveStatus(active, at(30 * DAY - 1), 3).status).toBe("active");
    expect(effectiveStatus(active, at(30 * DAY + 1), 3).status).toBe("past_due");
    expect(effectiveStatus(active, at(33 * DAY), 3).status).toBe("suspended");
    expect(effectiveStatus(active, at(30 * DAY), 0).status).toBe("suspended"); // no grace configured
  });

  it("cancellation takes effect at period end, not before", () => {
    const c = applyEvent(active, { type: "cancel_requested" }, at(5 * DAY));
    expect(c.cancelAtPeriodEnd).toBe(true);
    expect(effectiveStatus(c, at(10 * DAY), 3).status).toBe("active");
    expect(effectiveStatus(c, at(30 * DAY), 3).status).toBe("canceled");
    expect(applyEvent(c, { type: "resume_requested" }, at(6 * DAY)).cancelAtPeriodEnd).toBe(false);
  });

  it("only a payment event activates, and it replaces plan and period", () => {
    const next = applyEvent(trial, { type: "payment_succeeded", planKey: "growth", periodStart: at(2 * DAY), periodEnd: at(32 * DAY) }, at(2 * DAY));
    expect(next).toMatchObject({ status: "active", planKey: "growth", cancelAtPeriodEnd: false });
    expect(next.currentPeriodEnd).toEqual(at(32 * DAY));
  });

  it("rejects nonsensical transitions", () => {
    expect(() => applyEvent({ ...active, status: "canceled" }, { type: "cancel_requested" }, T0)).toThrow(InvalidTransitionError);
    expect(() => applyEvent(active, { type: "resume_requested" }, T0)).toThrow(InvalidTransitionError);
    expect(() => applyEvent(active, { type: "payment_succeeded", planKey: "x", periodStart: at(DAY), periodEnd: at(DAY) }, T0)).toThrow(
      InvalidTransitionError,
    );
    expect(() => applyEvent({ ...active, status: "suspended" }, { type: "payment_failed" }, T0)).toThrow(InvalidTransitionError);
  });

  it("payment failure moves an active subscription to past_due; a later payment restores it", () => {
    const pd = applyEvent(active, { type: "payment_failed" }, T0);
    expect(pd.status).toBe("past_due");
    expect(applyEvent(pd, { type: "payment_succeeded", planKey: "starter", periodStart: T0, periodEnd: at(30 * DAY) }, T0).status).toBe("active");
  });
});

describe("metering rules and rounding", () => {
  const policy = { ...getBillingPolicy(), roundingIncrementSeconds: 60, minAnsweredSeconds: 3, maxBillableSecondsPerCall: 600, billConnectedFailedCalls: true };
  const call = (over: Partial<Parameters<typeof computeBillable>[0]>) => ({
    status: "completed",
    callType: "outbound",
    startedAt: T0,
    endedAt: at(125_000),
    ...over,
  });

  it("rounds each call UP to the increment (125s -> 180s -> 3 minutes)", () => {
    expect(computeBillable(call({}), policy)).toMatchObject({ durationSeconds: 125, billableSeconds: 180, billableMinutes: 3, reason: "billed", state: "final" });
    expect(computeBillable(call({ endedAt: at(60_000) }), policy)).toMatchObject({ billableSeconds: 60, billableMinutes: 1 });
    expect(computeBillable(call({ endedAt: at(61_000) }), policy)).toMatchObject({ billableSeconds: 120, billableMinutes: 2 });
    expect(roundUp(1, 6)).toBe(6);
    expect(roundUp(0, 60)).toBe(0);
  });

  it("does not bill unanswered, too-short, test or (when configured) failed calls", () => {
    expect(computeBillable(call({ status: "failed", startedAt: null, endedAt: at(1000) }), policy)).toMatchObject({ billableSeconds: 0, reason: "unanswered" });
    expect(computeBillable(call({ endedAt: at(2000) }), policy)).toMatchObject({ billableSeconds: 0, reason: "too_short", durationSeconds: 2 });
    expect(computeBillable(call({ callType: "test" }), policy)).toMatchObject({ billableSeconds: 0, reason: "test_call" });
    expect(computeBillable(call({ status: "failed" }), { ...policy, billConnectedFailedCalls: false })).toMatchObject({ billableSeconds: 0, reason: "failed" });
    expect(computeBillable(call({ status: "failed" }), policy)).toMatchObject({ billableSeconds: 180 });
  });

  it("caps one call, records an interrupted call as pending, and ignores calls still in progress", () => {
    expect(computeBillable(call({ endedAt: at(3_600_000) }), policy)).toMatchObject({ billableSeconds: 600 });
    expect(computeBillable(call({ endedAt: null }), policy)).toMatchObject({ billableSeconds: 0, reason: "interrupted", state: "pending" });
    expect(computeBillable(call({ status: "in_progress", endedAt: null }), policy)).toBeNull();
    expect(computeBillable(call({ endedAt: at(-5000) }), policy)).toMatchObject({ durationSeconds: 0, billableSeconds: 0 });
  });
});

describe("billing policy", () => {
  afterEach(() => {
    delete process.env.BILLING_MIN_ANSWERED_SECONDS;
    delete process.env.BILLING_ENFORCEMENT;
  });
  it("reads overrides and falls back to defaults on invalid values (never disabling a guard)", () => {
    process.env.BILLING_MIN_ANSWERED_SECONDS = "10";
    expect(getBillingPolicy().minAnsweredSeconds).toBe(10);
    process.env.BILLING_MIN_ANSWERED_SECONDS = "-4";
    expect(getBillingPolicy().minAnsweredSeconds).toBe(3);
    process.env.BILLING_ENFORCEMENT = "bogus";
    expect(getBillingPolicy().enforcement).toBe("enforce");
  });
});

describe("mock payment provider (signature verification)", () => {
  const provider = createMockPaymentProvider("test-secret-of-sufficient-length");
  const body = JSON.stringify({
    id: "evt_1",
    type: "payment_succeeded",
    organizationId: "11111111-1111-4111-8111-111111111111",
    planKey: "starter",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-31T00:00:00.000Z",
    occurredAt: "2026-10-01T00:00:00.000Z",
  });

  it("accepts a correctly signed body and returns a typed event", () => {
    const e = provider.verifyWebhook(body, { "x-mock-signature": provider.sign(body) });
    expect(e).toMatchObject({ provider: "mock", eventId: "evt_1", type: "payment_succeeded", planKey: "starter" });
  });

  it("rejects a missing, wrong or tampered signature, and a malformed body", () => {
    expect(() => provider.verifyWebhook(body, {})).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(body, { "x-mock-signature": "00".repeat(32) })).toThrow(WebhookVerificationError);
    const tampered = body.replace("starter", "business");
    expect(() => provider.verifyWebhook(tampered, { "x-mock-signature": provider.sign(body) })).toThrow(WebhookVerificationError);
    const junk = "not json";
    expect(() => provider.verifyWebhook(junk, { "x-mock-signature": provider.sign(junk) })).toThrow(WebhookVerificationError);
  });

  it("refuses to be created in production or with a short secret", () => {
    expect(() => createMockPaymentProvider("short")).toThrow();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createMockPaymentProvider("test-secret-of-sufficient-length")).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("event ordering rule (isStalePaymentEvent)", () => {
  const sub = { currentPeriodStart: at(10 * DAY) };
  it("events that happened before the period in force are stale; equal-instant and later are not", async () => {
    const { isStalePaymentEvent } = await import("./subscription-state.js");
    expect(isStalePaymentEvent(sub, { type: "payment_failed", occurredAt: at(10 * DAY - 1) })).toBe(true);
    expect(isStalePaymentEvent(sub, { type: "payment_failed", occurredAt: at(10 * DAY) })).toBe(false);
    expect(isStalePaymentEvent(sub, { type: "subscription_canceled", occurredAt: at(11 * DAY) })).toBe(false);
    expect(isStalePaymentEvent(sub, { type: "payment_succeeded", occurredAt: at(12 * DAY), periodStart: at(9 * DAY) })).toBe(true);
    expect(isStalePaymentEvent(sub, { type: "payment_succeeded", occurredAt: at(12 * DAY), periodStart: at(10 * DAY) })).toBe(false);
  });
});

describe("entitlement enforcement matrix is complete", () => {
  it("every advertised entitlement key (and includedMinutes) has an explicit enforcement status", async () => {
    const { entitlementsSchema, ENTITLEMENT_ENFORCEMENT } = await import("./plan-types.js");
    const keys = [...Object.keys(entitlementsSchema.shape), "includedMinutes"].sort();
    expect(Object.keys(ENTITLEMENT_ENFORCEMENT).sort()).toEqual(keys);
  });

  it("nothing unenforced is advertised: every status is ENFORCED (decision D3, 2026-10-21)", async () => {
    const { ENTITLEMENT_ENFORCEMENT } = await import("./plan-types.js");
    expect(Object.entries(ENTITLEMENT_ENFORCEMENT).filter(([, v]) => v !== "ENFORCED")).toEqual([]);
    expect(Object.keys(ENTITLEMENT_ENFORCEMENT).sort()).toEqual(["includedMinutes", "maxAgents", "maxConcurrentCalls", "maxTeamMembers"]);
  });

  it("the keys removed as never-implemented are gone from the schema and the matrix", async () => {
    const { entitlementsSchema, limitOverridesSchema, ENTITLEMENT_ENFORCEMENT, REMOVED_ENTITLEMENTS } = await import("./plan-types.js");
    expect([...REMOVED_ENTITLEMENTS].sort()).toEqual(["analytics", "apiAccess", "retentionDays", "webhooks"]);
    for (const k of REMOVED_ENTITLEMENTS) {
      expect(Object.keys(entitlementsSchema.shape), k).not.toContain(k);
      expect(Object.keys(limitOverridesSchema.shape), k).not.toContain(k);
      expect(Object.keys(ENTITLEMENT_ENFORCEMENT), k).not.toContain(k);
    }
  });

  it("a stale removed key stored in plan entitlements or limit_overrides is ignored, not rejected", async () => {
    const { parseEntitlements, parseOverrides } = await import("./plan-types.js");
    // Exactly the seeded 0019 shape, as a database not yet at 0025 still holds it.
    expect(parseEntitlements({ maxConcurrentCalls: 3, maxAgents: 3, maxTeamMembers: 5, retentionDays: 30, analytics: "basic", apiAccess: false, webhooks: false })).toEqual({
      maxConcurrentCalls: 3,
      maxAgents: 3,
      maxTeamMembers: 5,
    });
    // A negotiated override row written before the removal keeps its real limits and loses only the dead keys.
    expect(parseOverrides({ includedMinutes: 5000, maxAgents: 12, retentionDays: 730, analytics: "advanced", apiAccess: true, webhooks: true })).toEqual({
      includedMinutes: 5000,
      maxAgents: 12,
    });
    // Nonsense in a dead key cannot break the read either (it is stripped before validation can object).
    expect(parseOverrides({ maxConcurrentCalls: 2, analytics: "platinum", retentionDays: -1 })).toEqual({ maxConcurrentCalls: 2 });
  });
});
