/**
 * Subscription state machine. Pure: no database, no clock (callers pass `now`).
 *
 * Persisted statuses: trialing | active | past_due | suspended | canceled | expired.
 * Time-based changes (trial end, period end, grace end) are NOT written on read: `effectiveStatus` computes what the
 * status IS at `now`, so a missed sweep can never leave a lapsed organization looking active. Payment-driven changes
 * (`applyEvent`) only ever come from a VERIFIED payment event or an authorized owner action; nothing here can mark a
 * subscription paid on its own.
 *
 *   trialing --payment_succeeded--> active          trialing --(trial end)--> expired
 *   active   --payment_failed-----> past_due        active   --(period end, no renewal)--> past_due --(grace)--> suspended
 *   past_due --payment_succeeded--> active          open     --cancel_requested--> (cancel at period end) --> canceled
 *   suspended/expired/canceled --payment_succeeded--> active (a returning customer re-subscribes)
 */
import type { SubscriptionStatus } from "./plan-types.js";

const DAY_MS = 86_400_000;

export interface SubscriptionState {
  status: SubscriptionStatus;
  planKey: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

export type SubscriptionEvent =
  | { type: "payment_succeeded"; planKey: string; periodStart: Date; periodEnd: Date }
  | { type: "payment_failed" }
  | { type: "cancel_requested" }
  | { type: "resume_requested" }
  | { type: "provider_canceled" };

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SubscriptionStatus,
    public readonly event: SubscriptionEvent["type"],
  ) {
    super(`A ${from} subscription cannot handle "${event}"`);
    this.name = "InvalidTransitionError";
  }
}

export interface EffectiveStatus {
  status: SubscriptionStatus;
  /** Set when the effective status differs from the stored one because of time alone. */
  derivedFrom?: SubscriptionStatus;
}

/** The status at `now`, applying trial end, period end, scheduled cancellation and the grace window. */
export function effectiveStatus(sub: SubscriptionState, now: Date, graceDays: number): EffectiveStatus {
  const stored = sub.status;
  const derive = (status: SubscriptionStatus): EffectiveStatus => (status === stored ? { status } : { status, derivedFrom: stored });
  const grace = graceDays * DAY_MS;
  const t = now.getTime();

  if (stored === "trialing") {
    const end = (sub.trialEndsAt ?? sub.currentPeriodEnd).getTime();
    if (t >= end) return derive(sub.cancelAtPeriodEnd ? "canceled" : "expired");
    return derive("trialing");
  }
  if (stored === "active" || stored === "past_due") {
    const end = sub.currentPeriodEnd.getTime();
    if (sub.cancelAtPeriodEnd && t >= end) return derive("canceled");
    if (stored === "active" && t < end) return derive("active");
    return derive(t < end + grace ? "past_due" : "suspended");
  }
  return derive(stored);
}

/** Applies a VERIFIED event. Throws InvalidTransitionError for combinations that make no sense. */
export function applyEvent(sub: SubscriptionState, event: SubscriptionEvent, now: Date): SubscriptionState {
  const from = sub.status;
  switch (event.type) {
    case "payment_succeeded":
      if (event.periodEnd <= event.periodStart) throw new InvalidTransitionError(from, event.type);
      return {
        ...sub,
        status: "active",
        planKey: event.planKey,
        currentPeriodStart: event.periodStart,
        currentPeriodEnd: event.periodEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      };
    case "payment_failed":
      if (from === "active") return { ...sub, status: "past_due" };
      if (from === "past_due" || from === "trialing") return sub; // nothing further to record
      throw new InvalidTransitionError(from, event.type);
    case "cancel_requested":
      if (from === "canceled" || from === "expired" || from === "suspended") throw new InvalidTransitionError(from, event.type);
      return { ...sub, cancelAtPeriodEnd: true, canceledAt: sub.canceledAt ?? now };
    case "resume_requested":
      if (!sub.cancelAtPeriodEnd || from === "canceled") throw new InvalidTransitionError(from, event.type);
      return { ...sub, cancelAtPeriodEnd: false, canceledAt: null };
    case "provider_canceled":
      return { ...sub, status: "canceled", cancelAtPeriodEnd: false, canceledAt: sub.canceledAt ?? now };
  }
}

/**
 * Event ordering rule (stateless, derived from the subscription's own columns; no last-event column exists).
 * A verified payment event is STALE, and must not change the subscription, when it happened before the billing
 * period now in force began:
 *   - any event with `occurredAt < currentPeriodStart` (a failure/cancellation/payment that predates the renewal
 *     that has already been applied), and
 *   - a payment_succeeded whose own period starts before the current period (an older cycle delivered late).
 * Equal-instant events are applied (not stale); redelivery of the SAME event id is handled by billing_events.
 * Limitation: two events inside the same period are applied in arrival order (see docs/billing/payment-event-ordering.md).
 */
export function isStalePaymentEvent(
  sub: Pick<SubscriptionState, "currentPeriodStart">,
  event: { type: string; occurredAt: Date; periodStart?: Date },
): boolean {
  if (event.occurredAt.getTime() < sub.currentPeriodStart.getTime()) return true;
  if (event.type === "payment_succeeded" && event.periodStart && event.periodStart.getTime() < sub.currentPeriodStart.getTime()) return true;
  return false;
}
