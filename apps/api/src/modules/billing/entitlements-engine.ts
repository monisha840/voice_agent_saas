/**
 * The entitlement evaluator: ONE place that answers "what may this organization do right now?".
 *
 * Inputs are server-side state only: the subscription row, the plan catalog, and the usage ledger (derived from the
 * call lifecycle). Nothing from the client. It FAILS SAFE: if the subscription is unreadable, the plan is missing,
 * limits are not configured, or usage cannot be reconciled, the answer is "not allowed" with a structured reason.
 *
 * Organizations with no subscription row are UNMANAGED (every organization that existed before billing): they are
 * allowed and keep today's configuration-based limits. That is an explicit, reported state, not a silent default.
 *
 * Concurrency: the concurrent-call cap is enforced atomically by the call repository (advisory lock per organization);
 * this evaluator supplies the cap. The included-minutes check happens at call start and cannot know a new call's
 * length, so overage is bounded by (concurrent calls x BILLING_MAX_CALL_SECONDS) - documented in docs/billing.
 */
import { runInTenant } from "../../db/tenant-context.js";
import {
  plansRepository,
  subscriptionsRepository,
  usageLedgerRepository,
  type PlanRow,
  type SubscriptionRow,
} from "../../db/repositories/billing.repository.js";
import { getBillingPolicy } from "./billing-policy.js";
import { meteringEngine } from "./metering-engine.js";
import { effectiveStatus } from "./subscription-state.js";
import {
  parseEntitlements,
  parseOverrides,
  type Entitlements,
  type EntitlementReason,
  type NextStep,
  type PlanView,
  type SubscriptionStatus,
} from "./plan-types.js";
import { logger } from "../../shared/logger.js";

export function toPlanView(p: PlanRow): PlanView {
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    pricePaise: p.pricePaise,
    currency: p.currency,
    billingInterval: p.billingInterval,
    includedMinutes: p.includedMinutes,
    trialDays: p.trialDays,
    entitlements: parseEntitlements(p.entitlements),
    selfServe: p.pricePaise !== null && p.key !== "trial",
  };
}

export interface EntitlementSnapshot {
  /** false for organizations that predate billing (no subscription row). */
  managed: boolean;
  allowed: boolean;
  reason: EntitlementReason;
  nextStep: NextStep;
  message: string;
  status: SubscriptionStatus | null;
  /** Set when time alone moved the status (e.g. trialing -> expired) and the stored row has not been swept yet. */
  storedStatus: SubscriptionStatus | null;
  plan: PlanView | null;
  trialEndsAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlanKey: string | null;
  limits: Entitlements;
  /** Seat usage against the plan caps (enforced by database triggers, migration 0020). limit null = no cap. */
  seats: { agents: { used: number; limit: number | null }; teamMembers: { used: number; limit: number | null } };
  usage: {
    includedMinutes: number;
    usedMinutes: number;
    remainingMinutes: number;
    usedSeconds: number;
    calls: number;
    /** Entries not yet final (interrupted calls awaiting an end time or correction). */
    pendingEntries: number;
    roundingPolicy: string;
  };
}

const EMPTY_USAGE = { includedMinutes: 0, usedMinutes: 0, remainingMinutes: 0, usedSeconds: 0, calls: 0, pendingEntries: 0, roundingPolicy: "" };

function deny(partial: Partial<EntitlementSnapshot> & Pick<EntitlementSnapshot, "reason" | "message" | "nextStep">): EntitlementSnapshot {
  return {
    managed: true,
    allowed: false,
    status: null,
    storedStatus: null,
    plan: null,
    trialEndsAt: null,
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlanKey: null,
    limits: {},
    seats: { agents: { used: 0, limit: null }, teamMembers: { used: 0, limit: null } },
    usage: EMPTY_USAGE,
    ...partial,
  };
}

/** Evaluates the organization at `now`. Never throws: an unreadable state is a denial (STATE_UNAVAILABLE). */
export async function evaluateEntitlements(organizationId: string, now = new Date()): Promise<EntitlementSnapshot> {
  const policy = getBillingPolicy();
  try {
    return await runInTenant({ organizationId }, async () => {
      const sub = await subscriptionsRepository.find({ organizationId });
      if (!sub) {
        return deny({
          managed: false,
          allowed: true,
          reason: "UNMANAGED_LEGACY",
          nextStep: "none",
          message: "This organization is not on a managed plan; platform default limits apply.",
        });
      }
      const plan = await plansRepository.get({ key: sub.planKey });
      if (!plan) {
        return deny({ reason: "PLAN_UNAVAILABLE", nextStep: "contact_sales", message: "Your plan could not be found. Please contact support." });
      }
      return evaluateWith(organizationId, sub, plan, now, policy);
    });
  } catch (err) {
    logger.error("entitlements: state unavailable", { organizationId, error: err instanceof Error ? err.message : String(err) });
    return deny({
      reason: "STATE_UNAVAILABLE",
      nextStep: "none",
      message: "We could not verify your subscription right now. Please try again shortly.",
    });
  }
}

async function evaluateWith(
  organizationId: string,
  sub: SubscriptionRow,
  plan: PlanRow,
  now: Date,
  policy: ReturnType<typeof getBillingPolicy>,
): Promise<EntitlementSnapshot> {
  // Usage must include every call that has ended, so reconcile first. If that fails the caller falls back to
  // STATE_UNAVAILABLE rather than trusting a stale (under-counted) total.
  const drained = await meteringEngine.reconcileAll(organizationId);
  if (!drained.drained) throw new Error("usage backlog not drained"); // fail closed (STATE_UNAVAILABLE) rather than under-count

  const eff = effectiveStatus(
    {
      status: sub.status,
      planKey: sub.planKey,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAt,
    },
    now,
    policy.gracePeriodDays,
  );
  const overrides = parseOverrides(sub.limitOverrides);
  const planView = toPlanView(plan);
  const limits: Entitlements = { ...planView.entitlements };
  for (const [k, v] of Object.entries(overrides)) if (k !== "includedMinutes" && v !== undefined) (limits as Record<string, unknown>)[k] = v;
  const includedMinutes = overrides.includedMinutes ?? plan.includedMinutes;

  const totals = await usageLedgerRepository.totals({ organizationId, from: sub.currentPeriodStart, to: sub.currentPeriodEnd });
  const seatCounts = await subscriptionsRepository.seatCounts({ organizationId });
  const usedSeconds = totals.billableSeconds;
  const usedMinutes = Math.ceil(usedSeconds / 60);
  const usage = {
    includedMinutes,
    usedMinutes,
    remainingMinutes: Math.max(0, includedMinutes - usedMinutes),
    usedSeconds,
    calls: totals.entries,
    pendingEntries: totals.pending,
    roundingPolicy: policy.roundingPolicyLabel,
  };

  const base = {
    managed: true,
    status: eff.status,
    storedStatus: sub.status,
    plan: planView,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    periodStart: sub.currentPeriodStart.toISOString(),
    periodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    scheduledPlanKey: sub.scheduledPlanKey,
    limits,
    seats: {
      agents: { used: seatCounts.agents, limit: limits.maxAgents ?? null },
      teamMembers: { used: seatCounts.teamMembers, limit: limits.maxTeamMembers ?? null },
    },
    usage,
  };
  const topTier = plan.pricePaise === null || plan.key === "business";
  const upgrade: NextStep = topTier ? "contact_sales" : "upgrade";

  const refuse = (reason: EntitlementReason, nextStep: NextStep, message: string): EntitlementSnapshot => ({
    ...base,
    allowed: false,
    reason,
    nextStep,
    message,
  });

  if (policy.enforcement === "off") {
    return { ...base, allowed: true, reason: "ENFORCEMENT_DISABLED", nextStep: "none", message: "Plan enforcement is switched off for this deployment." };
  }

  switch (eff.status) {
    case "expired":
      return plan.key === "trial"
        ? refuse("TRIAL_EXPIRED", "upgrade", "Your trial has ended. Choose a plan to keep making calls.")
        : refuse("SUBSCRIPTION_EXPIRED", upgrade, "Your subscription has expired. Choose a plan to keep making calls.");
    case "suspended":
      return refuse("SUBSCRIPTION_SUSPENDED", "update_payment", "Your subscription is suspended because a payment is outstanding.");
    case "canceled":
      return refuse("SUBSCRIPTION_CANCELED", "upgrade", "Your subscription has been canceled. Choose a plan to resume calling.");
    case "trialing":
    case "active":
    case "past_due":
      break;
    default:
      // A status this code does not know (e.g. added by a newer deployment) is never treated as "allowed".
      return refuse("STATE_UNAVAILABLE", "contact_sales", "Your subscription is in a state we could not interpret. Please contact support.");
  }

  if (!limits.maxConcurrentCalls || (plan.pricePaise === null && overrides.includedMinutes === undefined)) {
    return refuse("LIMITS_NOT_CONFIGURED", "contact_sales", "Limits for this plan have not been configured yet. Please contact sales.");
  }
  if (usedSeconds >= includedMinutes * 60) {
    return refuse(
      "MINUTES_EXHAUSTED",
      eff.status === "trialing" ? "upgrade" : upgrade,
      eff.status === "trialing"
        ? "Your trial minutes are used up. Choose a plan to keep making calls."
        : "This period's included minutes are used up. Upgrade, or wait for the next period.",
    );
  }
  return {
    ...base,
    allowed: true,
    reason: "OK",
    nextStep: eff.status === "past_due" ? "update_payment" : "none",
    message: eff.status === "past_due" ? "A payment is outstanding; calls continue during the grace period." : "Active.",
  };
}
