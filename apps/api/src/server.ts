import { loadEnv } from "./config/env.js";
loadEnv();

import { buildApp } from "./app.js";

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT_API ?? 4000);

  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
