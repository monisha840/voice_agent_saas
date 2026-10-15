/**
 * Metering at the moment a call reaches a terminal state. Called by the call lifecycle right after the atomic
 * terminal transition succeeded (exactly one caller wins that transition), for EVERY terminal outcome: completed,
 * failed, busy, no-answer, reaped. It is not tied to summary generation, so an LLM outage or a missing conversation
 * row can no longer lose usage.
 *
 * Best-effort by design: it never throws into the lifecycle. Anything missed here (process crash between the
 * transition and this call) is caught by reconcile, which every entitlement evaluation runs first; both paths are
 * idempotent on the same ledger key, so running both can never double-count.
 */
import { logger } from "../../shared/logger.js";
import { meteringEngine, type MeterableCallRecord } from "./metering-engine.js";

export async function meterEndedCall(organizationId: string, call: MeterableCallRecord): Promise<void> {
  try {
    await meteringEngine.meterCall(organizationId, call, "call_lifecycle");
  } catch (err) {
    logger.error("billing: could not meter ended call (reconcile will retry)", {
      callId: call.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
