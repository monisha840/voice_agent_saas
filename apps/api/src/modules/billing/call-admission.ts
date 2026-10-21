/**
 * The single hook between call creation and the subscription entitlements. `callLimits.createCall` calls `admit`
 * before it inserts a call, for every call type and every channel (outbound, test, inbound), so quota enforcement is
 * independent of the telephony provider and cannot be skipped by a route.
 *
 *   - unmanaged organizations (no subscription): admitted, no plan cap (today's configured limits apply);
 *   - managed organizations: admitted only when the entitlement evaluation allows, with the plan's concurrent-call cap
 *     (enforced atomically by the call repository under its per-organization lock).
 * A refusal is a LimitExceededError carrying the structured reason code and the next step in its message.
 */
import { LimitExceededError } from "../../shared/errors.js";
import { getBillingPolicy } from "./billing-policy.js";
import { evaluateEntitlements } from "./entitlements-engine.js";

export interface Admission {
  /** The plan's concurrent-call cap, or null when no plan applies (unmanaged / enforcement off). */
  maxConcurrentCalls: number | null;
  /**
   * Included-minute guard to re-check atomically under the per-organization lock at insert time (the evaluation above
   * is a snapshot; this closes the check-then-act gap). null when no included-minute limit applies.
   */
  minutes: { periodStart: Date; periodEnd: Date; includedSeconds: number; reserveSecondsPerCall: number } | null;
}

const NEXT_STEP_TEXT = {
  upgrade: "Choose a plan in Billing to continue.",
  contact_sales: "Contact sales to continue.",
  update_payment: "Update your payment in Billing to continue.",
  wait_for_next_period: "Try again when the next period starts.",
  none: "",
} as const;

export const callAdmission = {
  async admit(organizationId: string, now = new Date()): Promise<Admission> {
    const snap = await evaluateEntitlements(organizationId, now);
    if (!snap.managed || snap.reason === "ENFORCEMENT_DISABLED") return { maxConcurrentCalls: null, minutes: null };
    if (!snap.allowed) {
      const code = snap.reason as Extract<
        LimitExceededError["code"],
        | "TRIAL_EXPIRED"
        | "SUBSCRIPTION_SUSPENDED"
        | "SUBSCRIPTION_CANCELED"
        | "SUBSCRIPTION_EXPIRED"
        | "MINUTES_EXHAUSTED"
        | "PLAN_UNAVAILABLE"
        | "LIMITS_NOT_CONFIGURED"
        | "STATE_UNAVAILABLE"
      >;
      throw new LimitExceededError(`${snap.message} ${NEXT_STEP_TEXT[snap.nextStep]}`.trim(), code);
    }
    const minutes =
      snap.periodStart && snap.periodEnd
        ? {
            periodStart: new Date(snap.periodStart),
            periodEnd: new Date(snap.periodEnd),
            includedSeconds: snap.usage.includedMinutes * 60,
            reserveSecondsPerCall: getBillingPolicy().admissionReserveSecondsPerCall,
          }
        : null;
    return { maxConcurrentCalls: snap.limits.maxConcurrentCalls ?? null, minutes };
  },
};
