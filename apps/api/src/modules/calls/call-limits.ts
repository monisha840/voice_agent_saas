/**
 * Cost and abuse protection for call creation, per organization. Every call, outbound, test or inbound, is created
 * through `callLimits.createCall`, which enforces:
 *
 *  - the instance is not draining for shutdown;
 *  - the monthly call-seconds quota (from the usage ledger);
 *  - the concurrent-call limit and the rolling-24h call quota, checked and inserted atomically (the repository
 *    serializes them with a per-organization advisory lock, so parallel requests cannot both squeeze under a limit).
 *
 * Fail-safe: nothing here swallows an error. If a count cannot be read the call is not created. Limits are read when
 * the call starts and never touch calls that are already running; lowering a limit below the current number of live
 * calls only stops new calls until the number falls.
 *
 * Limits come from configuration (config/env.ts) for every organization today. `limitsFor` is the single place a
 * per-organization override would plug in, once there is somewhere to store it.
 */
import { callsRepository, type NewCallParams } from "../../db/repositories/calls.repository.js";
import { usageRepository } from "../../db/repositories/usage.repository.js";
import { getConfig, type AppConfig } from "../../config/env.js";
import { LimitExceededError } from "../../shared/errors.js";
import { lifecycle } from "../../runtime/lifecycle.js";
import { logger } from "../../shared/logger.js";

export type OrgLimits = Pick<AppConfig["limits"], "maxConcurrentCallsPerOrg" | "maxCallsPerOrgPerDay" | "maxCallSecondsPerOrgPerMonth">;

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export const callLimits = {
  /** The limits that apply to this organization. */
  async limitsFor(_organizationId: string): Promise<OrgLimits> {
    const l = getConfig().limits;
    return {
      maxConcurrentCallsPerOrg: l.maxConcurrentCallsPerOrg,
      maxCallsPerOrgPerDay: l.maxCallsPerOrgPerDay,
      maxCallSecondsPerOrgPerMonth: l.maxCallSecondsPerOrgPerMonth,
    };
  },

  /** Throws LimitExceededError when the organization has used up its month of call seconds. */
  async assertWithinMonthlyQuota(organizationId: string, limits: OrgLimits, now = new Date()): Promise<void> {
    if (limits.maxCallSecondsPerOrgPerMonth <= 0) return;
    const rows = await usageRepository.summarize({ organizationId, from: monthStartUtc(now), to: new Date(now.getTime() + 1) });
    const used = rows.find((r) => r.type === "call_seconds")?.total ?? 0;
    if (used >= limits.maxCallSecondsPerOrgPerMonth) {
      throw new LimitExceededError(
        `Monthly call-time quota reached (${limits.maxCallSecondsPerOrgPerMonth} seconds). It resets at the start of next month.`,
        "MONTHLY_CALL_SECONDS_QUOTA",
      );
    }
  },

  /** Creates the call record if every guard passes; otherwise throws and creates nothing. */
  async createCall(params: NewCallParams) {
    lifecycle.assertAcceptingCalls();
    const limits = await callLimits.limitsFor(params.organizationId);
    await callLimits.assertWithinMonthlyQuota(params.organizationId, limits);

    const result = await callsRepository.createWithinLimits({
      ...params,
      maxConcurrent: limits.maxConcurrentCallsPerOrg,
      maxPerDay: limits.maxCallsPerOrgPerDay,
    });
    if ("call" in result) return result.call;

    logger.warn("call-limits: call refused", { organizationId: params.organizationId, callType: params.callType, limit: result.blocked });
    if (result.blocked === "concurrent") {
      throw new LimitExceededError(
        `Too many calls in progress: this organization may have at most ${result.limit} at a time. Try again when one ends.`,
        "CONCURRENT_CALL_LIMIT",
        15,
      );
    }
    throw new LimitExceededError(
      `Daily call quota reached: at most ${result.limit} calls in any 24 hours per organization.`,
      "DAILY_CALL_QUOTA",
    );
  },
};
