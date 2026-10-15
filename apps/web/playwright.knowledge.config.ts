import { defineConfig } from "@playwright/test";

// Knowledge-base / playground browser e2e. Run with `pnpm --filter @voice-agent/web e2e:knowledge` (e2e/knowledge-run.mjs
// owns DB, servers and teardown with its own database, role and ports).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /knowledge\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3491", headless: true, screenshot: "only-on-failure", trace: "off" },
});
