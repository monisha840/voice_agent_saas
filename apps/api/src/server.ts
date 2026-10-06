import { loadEnv } from "./config/env.js";
loadEnv();

import { buildApp } from "./app.js";
import { startStaleCallReaper } from "./modules/calls/stale-calls.worker.js";

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT_API ?? 4000);

  try {
    await app.listen({ port, host: "0.0.0.0" });
    startStaleCallReaper();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
