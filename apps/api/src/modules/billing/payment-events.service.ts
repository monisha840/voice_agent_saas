/**
 * Applies VERIFIED payment-provider events to subscriptions (the only path by which a subscription becomes `active`).
 *
 * The caller (a future webhook route) must first pass the raw request through `PaymentProvider.verifyWebhook`; this
 * service accepts only the resulting VerifiedPaymentEvent. It is system-only: a logged-in user can never invoke it.
 *
 * Idempotent on (provider, eventId); one transaction records the event and applies its effect. A concurrent change
 * to the subscription yields "conflict" (nothing written) so the provider's redelivery is processed against fresh
 * state. Events that make no sense for the current state are recorded as "ignored" (so they are not retried forever).
 *
 * NOT wired to a public route in this milestone: a webhook endpoint is a public, unauthenticated surface and belongs
 * to the security-owned route allow-list (see docs/billing/README.md, "Activating payments").
 */
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { billingEventsRepository, plansRepository, subscriptionsRepository } from "../../db/repositories/billing.repository.js";
import { ForbiddenError, ValidationError } from "../../shared/errors.js";
import type { VerifiedPaymentEvent } from "./payment-provider.js";
import { applyEvent, InvalidTransitionError, isStalePaymentEvent, type SubscriptionEvent, type SubscriptionState } from "./subscription-state.js";

/** "stale": the event predates the period now in force; recorded as ignored, nothing changed. */
export type PaymentEventResult = "applied" | "ignored" | "duplicate" | "conflict" | "stale";

const paymentEventsServiceImpl = {
  async handleVerified(ctx: RequestContext, event: VerifiedPaymentEvent): Promise<PaymentEventResult> {
    if (ctx.actor.type !== "system") throw new ForbiddenError("Payment events are processed by the system only");
    // The tenant is the one named by the SIGNED event; the context must agree (it was derived from the same event).
    if (event.organizationId !== ctx.organizationId) throw new ForbiddenError("Payment event does not belong to this organization");
    assertCan(ctx, "org:read");

    // Input validation FIRST: a malformed (but correctly signed) event is a ValidationError (HTTP 400-shaped), never a
    // CHECK violation / 500 from the database, and is not recorded as handled.
    if (event.type === "payment_succeeded") {
      if (!event.planKey || !event.periodStart || !event.periodEnd) throw new ValidationError("payment_succeeded needs plan and period");
      if (Number.isNaN(event.periodStart.getTime()) || Number.isNaN(event.periodEnd.getTime())) {
        throw new ValidationError("Payment event period is not a valid date");
      }
      if (event.periodEnd.getTime() <= event.periodStart.getTime()) {
        throw new ValidationError("Payment event periodEnd must be after periodStart");
      }
    }
    if (Number.isNaN(event.occurredAt.getTime())) {
      throw new ValidationError("Payment event occurredAt is not a valid date");
    }

    const sub = await subscriptionsRepository.find({ organizationId: ctx.organizationId });
    const record = (outcome: "applied" | "ignored") => ({
      provider: event.provider,
      providerEventId: event.eventId,
      eventType: event.type,
      outcome,
      payloadDigest: event.payloadDigest,
    });
    if (!sub) {
      // Nothing to apply to: remember the event id so a redelivery is a no-op, but change nothing.
      const r = await billingEventsRepository.recordAndApply({ organizationId: ctx.organizationId, event: record("ignored") });
      return r === "duplicate" ? "duplicate" : "ignored";
    }

    if (isStalePaymentEvent(sub, event)) {
      // Older than the period in force: remember the id (a redelivery stays a no-op) but change nothing.
      const r = await billingEventsRepository.recordAndApply({ organizationId: ctx.organizationId, event: record("ignored") });
      return r === "duplicate" ? "duplicate" : "stale";
    }

    let domainEvent: SubscriptionEvent;
    switch (event.type) {
      case "payment_succeeded": {
        if (!event.planKey || !event.periodStart || !event.periodEnd) throw new ValidationError("payment_succeeded needs plan and period");
        const plan = await plansRepository.get({ key: event.planKey });
        if (!plan || !plan.isActive) throw new ValidationError("Unknown plan in payment event");
        domainEvent = { type: "payment_succeeded", planKey: event.planKey, periodStart: event.periodStart, periodEnd: event.periodEnd };
        break;
      }
      case "payment_failed":
        domainEvent = { type: "payment_failed" };
        break;
      case "subscription_canceled":
        domainEvent = { type: "provider_canceled" };
        break;
    }

    let next: SubscriptionState;
    try {
      next = applyEvent(
        {
          status: sub.status,
          planKey: sub.planKey,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          canceledAt: sub.canceledAt,
        },
        domainEvent,
        event.occurredAt,
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        const r = await billingEventsRepository.recordAndApply({ organizationId: ctx.organizationId, event: record("ignored") });
        return r === "duplicate" ? "duplicate" : "ignored";
      }
      throw err;
    }

    const result = await billingEventsRepository.recordAndApply({
      organizationId: ctx.organizationId,
      event: record("applied"),
      subscription: {
        expectedUpdatedAt: sub.updatedAt,
        set: {
          status: next.status,
          planKey: next.planKey,
          currentPeriodStart: next.currentPeriodStart,
          currentPeriodEnd: next.currentPeriodEnd,
          cancelAtPeriodEnd: next.cancelAtPeriodEnd,
          canceledAt: next.canceledAt,
          scheduledPlanKey: event.type === "payment_succeeded" ? null : sub.scheduledPlanKey,
          paymentProvider: event.provider,
        },
      },
    });
    return result;
  },
};

export const paymentEventsService = tenantScoped(paymentEventsServiceImpl);
