/**
 * Turns a persisted call record into billable usage. Pure and deterministic: the source of truth is the call row
 * (timestamps written by the server's own call lifecycle), never a client-submitted duration or cost.
 *
 * Rules, in order:
 *  1. not yet terminal                         -> not meterable (null): nothing is recorded until the call ends
 *  2. test calls (callType "test")             -> 0, reason test_call
 *  3. never answered (no startedAt)            -> 0, reason unanswered
 *  4. answered but no endedAt (interrupted)    -> 0, state pending, reason interrupted (a later lifecycle event or an
 *                                                operator correction supersedes it)
 *  5. failed after connecting, policy says no  -> 0, reason failed
 *  6. duration < minAnsweredSeconds            -> 0, reason too_short
 *  7. otherwise                                -> min(duration, cap) rounded UP to the policy increment, reason billed
 * duration = max(0, round((endedAt - startedAt) / 1000)) whole seconds. billableMinutes = ceil(billableSeconds / 60).
 */
import type { BillingPolicy } from "./billing-policy.js";

export interface MeterableCall {
  status: string;
  callType: string;
  startedAt: Date | null;
  endedAt: Date | null;
}

export type BillableReason = "billed" | "unanswered" | "failed" | "too_short" | "test_call" | "interrupted";

export interface BillableUsage {
  durationSeconds: number;
  billableSeconds: number;
  billableMinutes: number;
  reason: BillableReason;
  outcome: "completed" | "failed" | "unanswered" | "interrupted" | "test";
  state: "final" | "pending";
  roundingPolicy: string;
}

const TERMINAL = new Set(["completed", "failed"]);

export function roundUp(seconds: number, increment: number): number {
  return seconds <= 0 ? 0 : Math.ceil(seconds / increment) * increment;
}

export function computeBillable(call: MeterableCall, policy: BillingPolicy): BillableUsage | null {
  const zero = (
    reason: BillableReason,
    outcome: BillableUsage["outcome"],
    state: BillableUsage["state"] = "final",
    durationSeconds = 0,
  ): BillableUsage => ({
    roundingPolicy: policy.roundingPolicyLabel,
    durationSeconds,
    billableSeconds: 0,
    billableMinutes: 0,
    reason,
    outcome,
    state,
  });

  if (!TERMINAL.has(call.status)) return null;
  const duration =
    call.startedAt && call.endedAt ? Math.max(0, Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000)) : 0;
  const connectedOutcome = call.status === "completed" ? "completed" : "failed";

  if (call.callType === "test") return zero("test_call", "test", "final", duration);
  if (!call.startedAt) return zero("unanswered", "unanswered");
  if (!call.endedAt) return zero("interrupted", "interrupted", "pending");
  if (call.status === "failed" && !policy.billConnectedFailedCalls) return zero("failed", "failed", "final", duration);
  if (duration === 0 || duration < policy.minAnsweredSeconds) return zero("too_short", connectedOutcome, "final", duration);

  const billableSeconds = roundUp(Math.min(duration, policy.maxBillableSecondsPerCall), policy.roundingIncrementSeconds);
  return {
    roundingPolicy: policy.roundingPolicyLabel,
    durationSeconds: duration,
    billableSeconds,
    billableMinutes: Math.ceil(billableSeconds / 60),
    reason: "billed",
    outcome: connectedOutcome,
    state: "final",
  };
}
