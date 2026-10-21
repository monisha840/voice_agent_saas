import { loadEnv, getConfig } from "./config/env.js";
loadEnv();

import { assertValidConfig, ConfigValidationError } from "./config/validate.js";
import { logger } from "./shared/logger.js";

// Fail the process, with every problem listed, before anything listens. (Imports below touch the database client,
// which also refuses to load without DATABASE_URL, so validate first.)
try {
  for (const warning of assertValidConfig()) logger.warn(`config: ${warning}`);
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { buildApp } = await import("./app.js");
const { startStaleCallReaper } = await import("./modules/calls/stale-calls.worker.js");
const { gracefulShutdown } = await import("./runtime/shutdown.js");
const { sql } = await import("./db/client.js");
const { inspectRuntimeRole } = await import("./runtime/db-role-check.js");
const { metrics } = await import("./runtime/metrics.js");
const { startSecurityJanitor } = await import("./runtime/security-janitor.js");

async function main() {
  // Row-level security only protects tenants if the runtime cannot bypass it: check what we connected as.
  const roleReport = await inspectRuntimeRole().catch((err) => ({
    role: "unknown",
    problems: [`could not inspect the database role: ${err instanceof Error ? err.message : String(err)}`],
  }));
  metrics.set("db_runtime_role_problems", roleReport.problems.length);
  if (roleReport.problems.length > 0) {
    metrics.inc("db_role_check_failures_total", { kind: roleReport.role === "unknown" ? "inspect_error" : "problems" });
    const text = `database role "${roleReport.role}" ${roleReport.problems.join("; ")}`;
    if (getConfig().nodeEnv === "production") {
      console.error(`Refusing to start: ${text}. Connect as the restricted runtime role (see docs/security/rls-rollout.md).`);
      process.exit(1);
    }
    logger.warn(`security: ${text}. Tenant isolation is NOT enforced by the database in this process.`);
  }

  const app = await buildApp();
  const port = Number(process.env.PORT_API ?? 4000);
  let stopReaper: (() => void) | undefined;
  let stopJanitor: (() => void) | undefined;

  try {
    await app.listen({ port, host: "0.0.0.0" });
    stopReaper = startStaleCallReaper();
    stopJanitor = startSecurityJanitor();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    if (shuttingDown) {
      logger.warn("shutdown: second signal, exiting immediately", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    gracefulShutdown(signal, {
      drainTimeoutMs: getConfig().shutdown.drainTimeoutMs,
      stopBackground: () => {
        stopReaper?.();
        stopJanitor?.();
      },
      closeServer: () => app.close(),
      closeDatabase: () => sql.end({ timeout: 5 }),
    })
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error("shutdown: failed", { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

main();
