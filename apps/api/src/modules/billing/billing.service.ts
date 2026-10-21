/**
 * Tenant-facing billing operations. Authorization (service layer, so it holds for every caller):
 *   - plan catalog           org:read    (every member)
 *   - status / usage         usage:read  (OWNER, ADMIN)
 *   - any change             org:manage  (OWNER only; ADMIN, MANAGER and AGENT cannot change a subscription)
 * The organization always comes from the verified RequestContext; no method accepts an organization id.
 *
 * What this milestone deliberately cannot do: activate or upgrade a PAID plan. That requires a verified payment event
 * (payment-events.service.ts); `requestPlanChange` only records the owner's intent for sales/checkout follow-up.
 */
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { plansRepository, subscriptionsRepository, usageLedgerRepository } from "../../db/repositories/billing.repository.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { evaluateEntitlements, toPlanView } from "./entitlements-engine.js";
import { meteringEngine } from "./metering-engine.js";
import { applyEvent, InvalidTransitionError, type SubscriptionEvent, type SubscriptionState } from "./subscription-state.js";
import { getBillingPolicy } from "./billing-policy.js";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

function encodeCursor(c: { occurredAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: c.occurredAt.toISOString(), id: c.id })).toString("base64url");
}

function decodeCursor(raw: string): { occurredAt: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    const when = typeof v.t === "string" ? new Date(v.t) : null;
    if (when && !Number.isNaN(when.getTime()) && typeof v.id === "string" && /^[0-9a-f-]{36}$/i.test(v.id)) {
      return { occurredAt: when, id: v.id };
    }
  } catch {
    // fall through
  }
  throw new ValidationError("Invalid request - cursor: not a valid page cursor");
}

function ledgerView(r: Awaited<ReturnType<typeof usageLedgerRepository.list>>[number]) {
  return {
    id: r.id,
    callId: r.callId,
    providerCallId: r.providerCallId,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    occurredAt: r.occurredAt.toISOString(),
    durationSeconds: r.durationSeconds,
    billableSeconds: r.billableSeconds,
    billableMinutes: r.billableMinutes,
    roundingPolicy: r.roundingPolicy,
    billableReason: r.billableReason,
    outcome: r.outcome,
    terminationReason: r.terminationReason,
    state: r.state,
    entryType: r.entryType,
    source: r.source,
  };
}

function asState(sub: NonNullable<Awaited<ReturnType<typeof subscriptionsRepository.find>>>): SubscriptionState {
  return {
    status: sub.status,
    planKey: sub.planKey,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt,
  };
}

const billingServiceImpl = {
  async listPlans(ctx: RequestContext) {
    assertCan(ctx, "org:read");
    const rows = await plansRepository.list();
    return rows.filter((p) => p.isPublic).map(toPlanView);
  },

  /** Subscription + entitlement + usage state, as the dashboard shows it. */
  async overview(ctx: RequestContext) {
    assertCan(ctx, "usage:read");
    const snapshot = await evaluateEntitlements(ctx.organizationId);
    return {
      ...snapshot,
      // No payment gateway is integrated: paid plans cannot be purchased online yet. The UI says so.
      paymentsEnabled: false,
      canManage: ctx.actor.type === "user" && ctx.actor.role === "OWNER",
      policy: (({ roundingIncrementSeconds, minAnsweredSeconds, gracePeriodDays }) => ({
        roundingIncrementSeconds,
        minAnsweredSeconds,
        gracePeriodDays,
      }))(getBillingPolicy()),
    };
  },

  async usageHistory(
    ctx: RequestContext,
    input: { limit: number; cursor?: string; from?: Date; to?: Date; includeSuperseded?: boolean },
  ) {
    assertCan(ctx, "usage:read");
    const limit = Math.min(Math.max(input.limit, 1), MAX_PAGE_SIZE);
    const before = input.cursor ? decodeCursor(input.cursor) : undefined;
    const rows = await usageLedgerRepository.list({
      organizationId: ctx.organizationId,
      limit: limit + 1,
      before,
      from: input.from,
      to: input.to,
      includeSuperseded: input.includeSuperseded,
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map(ledgerView),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  },

  /** Meters ended calls that are not in the ledger yet (idempotent; the client supplies nothing). */
  async reconcileUsage(ctx: RequestContext) {
    assertCan(ctx, "org:manage");
    return meteringEngine.reconcile(ctx.organizationId);
  },

  /**
   * For an organization with no subscription (created before billing): starts the catalog's trial. Never resets an
   * existing subscription, so it cannot be used to get a second trial. Concurrent calls: the unique constraint on
   * subscriptions.organization_id lets exactly one win; the other gets a 409.
   */
  async startTrial(ctx: RequestContext) {
    assertCan(ctx, "org:manage");
    const plan = await plansRepository.get({ key: "trial" });
    if (!plan || !plan.isActive || !plan.trialDays || plan.trialDays <= 0) {
      throw new ConflictError("Trials are not available right now");
    }
    const now = new Date();
    const end = new Date(now.getTime() + plan.trialDays * 86_400_000);
    const created = await subscriptionsRepository.insert({
      organizationId: ctx.organizationId,
      values: {
        planKey: plan.key,
        status: "trialing",
        trialEndsAt: end,
        currentPeriodStart: now,
        currentPeriodEnd: end,
      },
    });
    if (!created) throw new ConflictError("This organization already has a subscription");
    await auditService.record(ctx, {
      action: "subscription.trial_started",
      entityType: "subscription",
      entityId: created.id,
      metadata: { plan: plan.key, trialEndsAt: end.toISOString() },
    });
    return evaluateEntitlements(ctx.organizationId, now);
  },

  /**
   * Records which plan the owner wants. It changes NOTHING about entitlements: an upgrade needs a verified payment
   * (or a sales decision for custom plans). Returns what happens next so the UI can say it plainly.
   */
  async requestPlanChange(ctx: RequestContext, input: { planKey: string }) {
    assertCan(ctx, "org:manage");
    const plan = await plansRepository.get({ key: input.planKey });
    if (!plan || !plan.isActive || !plan.isPublic) throw new NotFoundError("Plan not found");
    const sub = await subscriptionsRepository.find({ organizationId: ctx.organizationId });
    if (!sub) throw new ConflictError("Start a trial before requesting a plan change");
    if (sub.planKey === plan.key) throw new ConflictError("You are already on this plan");
    const updated = await subscriptionsRepository.updateIfUnchanged({
      organizationId: ctx.organizationId,
      expectedUpdatedAt: sub.updatedAt,
      set: { scheduledPlanKey: plan.key },
    });
    if (!updated) throw new ConflictError("Your subscription changed while you were editing; reload and try again");
    await auditService.record(ctx, {
      action: "subscription.plan_change_requested",
      entityType: "subscription",
      entityId: sub.id,
      metadata: { from: sub.planKey, to: plan.key },
    });
    return {
      requestedPlanKey: plan.key,
      effective: false as const,
      nextStep: plan.pricePaise === null ? ("contact_sales" as const) : ("payment_required" as const),
      paymentsEnabled: false,
      message:
        plan.pricePaise === null
          ? "Your request has been recorded. Our team will contact you about custom pricing."
          : "Your request has been recorded. Online payment is not enabled yet; our team will contact you to activate the plan.",
    };
  },

  async cancel(ctx: RequestContext) {
    return transition(ctx, { type: "cancel_requested" }, "subscription.cancel_requested");
  },

  async resume(ctx: RequestContext) {
    return transition(ctx, { type: "resume_requested" }, "subscription.resumed");
  },
};

async function transition(ctx: RequestContext, event: SubscriptionEvent, auditAction: string) {
  assertCan(ctx, "org:manage");
  const sub = await subscriptionsRepository.find({ organizationId: ctx.organizationId });
  if (!sub) throw new NotFoundError("This organization has no subscription");
  const now = new Date();
  let next: SubscriptionState;
  try {
    next = applyEvent(asState(sub), event, now);
  } catch (err) {
    if (err instanceof InvalidTransitionError) throw new ConflictError(err.message);
    throw err;
  }
  const updated = await subscriptionsRepository.updateIfUnchanged({
    organizationId: ctx.organizationId,
    expectedUpdatedAt: sub.updatedAt,
    set: { cancelAtPeriodEnd: next.cancelAtPeriodEnd, canceledAt: next.canceledAt, status: next.status },
  });
  if (!updated) throw new ConflictError("Your subscription changed while you were editing; reload and try again");
  await auditService.record(ctx, {
    action: auditAction,
    entityType: "subscription",
    entityId: sub.id,
    metadata: { plan: sub.planKey, status: next.status, cancelAtPeriodEnd: next.cancelAtPeriodEnd },
  });
  return evaluateEntitlements(ctx.organizationId, now);
}

export const billingService = tenantScoped(billingServiceImpl);
