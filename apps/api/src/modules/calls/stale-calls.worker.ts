import { callsService } from "./calls.service.js";
import { getConfig } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

/**
 * Periodically closes calls whose final provider callback never arrived,
 * so a lost webhook cannot leave a call "in progress" and a lead stuck on
 * CALLING forever. Runs once at startup (to clean up after a crash) and
 * then on an interval. Not started by buildApp(), so tests stay quiet.
 * Returns a function that stops it.
 */
export function startStaleCallReaper(): () => void {
  const { pendingMs, inProgressMs, intervalMs } = getConfig().staleCalls;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await callsService.reapStaleCalls({ pendingMs, inProgressMs });
    } catch (err) {
      logger.error("stale-calls: reaper run failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
