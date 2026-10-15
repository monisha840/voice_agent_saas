/**
 * Periodic housekeeping for security tables: removes expired sessions and stale login-throttle counters so neither
 * grows without bound, and (only when explicitly enabled) applies the security_events retention policy. Idempotent
 * and cheap; failures are logged and retried on the next tick. Never runs inside a request path.
 */
import { sessionsRepository } from "../db/repositories/sessions.repository.js";
import {
  authThrottleRepository,
  securityEventRetentionRepository,
  streamClaimsRepository,
  streamGrantsRepository,
  streamTokenUsesRepository,
} from "../db/repositories/security.repository.js";
import { getConfig } from "../config/env.js";
import { purgeExpiredRateLimitBuckets } from "../security/rate-limits.js";
import { securityEvents } from "../security/security-events.js";
import { logger } from "../shared/logger.js";
import { metrics } from "./metrics.js";

const INTERVAL_MS = 10 * 60_000;
const THROTTLE_RETENTION_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export interface RetentionResult {
  ran: boolean;
  purged: Record<string, number>;
  total: number;
  batches: number;
  error?: string;
}

/**
 * Applies the security_events retention policy in bounded batches. Safe to run on several instances at once (the
 * database function skips rows another run has locked). Never throws: a failure is logged and reported in the
 * result. Disabled (a no-op) unless SECURITY_EVENT_RETENTION_ENABLED=true.
 */
export async function runSecurityEventRetentionOnce(now: Date = new Date()): Promise<RetentionResult> {
  const cfg = getConfig().securityRetention;
  const result: RetentionResult = { ran: false, purged: {}, total: 0, batches: 0 };
  if (!cfg.enabled) return result;
  result.ran = true;

  const cutoffs: Record<string, Date> = {};
  for (const [category, days] of Object.entries(cfg.daysByCategory)) {
    cutoffs[category] = new Date(now.getTime() - Math.max(1, days) * DAY_MS);
  }

  try {
    for (let i = 0; i < cfg.maxBatchesPerRun; i++) {
      const counts = await securityEventRetentionRepository.purge({ cutoffs, batch: cfg.batchSize, archive: cfg.archive });
      result.batches++;
      let batchTotal = 0;
      for (const [category, n] of Object.entries(counts)) {
        result.purged[category] = (result.purged[category] ?? 0) + n;
        batchTotal += n;
      }
      result.total += batchTotal;
      if (batchTotal < cfg.batchSize) break; // drained (or the rest is locked by another run)
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    metrics.inc("security_event_retention_errors_total");
    metrics.inc("security_janitor_failures_total", { task: "retention" });
    logger.error("security-janitor: security event retention failed", { error: result.error, purged: result.total });
  }

  if (result.total > 0) {
    metrics.inc("security_event_retention_purged_total", {}, result.total);
    // Counts only: no event payloads are ever logged or recorded here.
    logger.info("security-janitor: security events purged", {
      total: result.total,
      batches: result.batches,
      archived: cfg.archive,
      ...result.purged,
    });
    await securityEvents.record({
      type: "system.privileged_action",
      outcome: result.error ? "failure" : "success",
      metadata: {
        action: "security_events.retention_purge",
        archived: cfg.archive,
        total: result.total,
        batches: result.batches,
        byCategory: result.purged,
      },
    });
  }
  return result;
}

export async function runSecurityJanitorOnce(now: Date = new Date()) {
  try {
    await sessionsRepository.deleteExpired({ now });
    await authThrottleRepository.deleteStale({ before: new Date(now.getTime() - THROTTLE_RETENTION_MS) });
    await streamTokenUsesRepository.deleteExpired({ before: now });
    await streamClaimsRepository.deleteStale({ before: new Date(now.getTime() - DAY_MS) });
    await streamGrantsRepository.deleteExpired({ before: now });
    await purgeExpiredRateLimitBuckets(now);
    metrics.set("security_janitor_last_success_timestamp_seconds", Math.floor(Date.now() / 1000));
  } catch (err) {
    metrics.inc("security_janitor_failures_total", { task: "cleanup" });
    throw err;
  } finally {
    // Independent of the cleanup above: a failing step must not starve retention (and retention never throws).
    await runSecurityEventRetentionOnce(now);
  }
}

export function startSecurityJanitor(): () => void {
  const tick = () => {
    runSecurityJanitorOnce().catch((err) =>
      logger.warn("security-janitor: cleanup failed", { error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
