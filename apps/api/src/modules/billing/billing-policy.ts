/**
 * Business-configurable billing/metering policy. Every value is a provisional default awaiting business approval;
 * each can be overridden by an environment variable (documented in docs/billing/README.md). Read lazily so tests and
 * operators can change it without a rebuild. An invalid value falls back to the default (it never disables a guard).
 */
export interface BillingPolicy {
  /** Whole seconds each call's billable time is rounded UP to (60 = per-started-minute). */
  roundingIncrementSeconds: number;
  /** Answered calls shorter than this are not billed (0 = bill everything that connected). */
  minAnsweredSeconds: number;
  /** A single call can never bill more than this (guards reaper-estimated end times). */
  maxBillableSecondsPerCall: number;
  /** Bill calls that connected and then failed/dropped (true) or only calls that completed (false). */
  billConnectedFailedCalls: boolean;
  /**
   * Seconds reserved against the included minutes for every call already in flight when a new call is admitted
   * (reserve-then-settle: the reservation is released implicitly when the call ends and its real usage is metered).
   * 0 = in-flight calls reserve nothing (only already-metered usage is compared). Default: one billing increment,
   * the least an answered call can bill.
   */
  admissionReserveSecondsPerCall: number;
  /** Days after a paid period ends (or a payment fails) before the subscription is suspended. */
  gracePeriodDays: number;
  /** "enforce": quotas/limits refuse calls. "off": nothing is refused (status is still reported). */
  enforcement: "enforce" | "off";
  /** Stored on every ledger row so a later policy change never reinterprets old rows. */
  roundingPolicyLabel: string;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function getBillingPolicy(): BillingPolicy {
  const roundingIncrementSeconds = int("BILLING_ROUNDING_INCREMENT_SECONDS", 60, 1, 600);
  return {
    roundingIncrementSeconds,
    minAnsweredSeconds: int("BILLING_MIN_ANSWERED_SECONDS", 3, 0, 600),
    maxBillableSecondsPerCall: int("BILLING_MAX_CALL_SECONDS", 7200, 60, 86_400),
    billConnectedFailedCalls: process.env.BILLING_BILL_CONNECTED_FAILED_CALLS !== "false",
    admissionReserveSecondsPerCall: int("BILLING_ADMISSION_RESERVE_SECONDS", roundingIncrementSeconds, 0, 86_400),
    gracePeriodDays: int("BILLING_GRACE_DAYS", 3, 0, 60),
    enforcement: process.env.BILLING_ENFORCEMENT === "off" ? "off" : "enforce",
    roundingPolicyLabel: `ceil_${roundingIncrementSeconds}s_per_call`,
  };
}
