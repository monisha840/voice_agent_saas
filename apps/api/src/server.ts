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

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT_API ?? 4000);
  let stopReaper: (() => void) | undefined;

  try {
    await app.listen({ port, host: "0.0.0.0" });
    stopReaper = startStaleCallReaper();
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
      stopBackground: stopReaper,
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
