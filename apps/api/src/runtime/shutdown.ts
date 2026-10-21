/**
 * Graceful shutdown: stop taking new calls, let live calls finish, then close everything and exit.
 *
 * Order matters:
 *  1. Mark the instance draining: /ready goes 503 (the load balancer stops sending traffic) and new calls are
 *     refused. HTTP stays up so provider status callbacks and the dashboard keep working while calls wind down.
 *  2. Wait for live calls to end by themselves, up to the drain timeout; then close what is left (1001).
 *  3. Stop accepting connections and finish in-flight requests (app.close), then close the database pool.
 *
 * Dependencies are injected so the sequence is testable without killing the test process.
 */
import { lifecycle } from "./lifecycle.js";
import { logger } from "../shared/logger.js";

export interface ShutdownDeps {
  closeServer: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  /** Stops background timers such as the stale-call reaper. */
  stopBackground?: () => void;
  drainTimeoutMs: number;
}

export async function gracefulShutdown(signal: string, deps: ShutdownDeps): Promise<{ forcedClosed: number }> {
  logger.info("shutdown: signal received", { signal, liveCalls: lifecycle.liveCallCount() });
  lifecycle.beginDrain();
  deps.stopBackground?.();
  const { forcedClosed } = await lifecycle.drain({ timeoutMs: deps.drainTimeoutMs });
  await deps.closeServer();
  await deps.closeDatabase();
  logger.info("shutdown: complete", { forcedClosed });
  return { forcedClosed };
}
