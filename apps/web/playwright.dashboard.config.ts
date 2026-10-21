import { defineConfig } from "@playwright/test";

// Customer dashboard browser e2e. Run with `pnpm --filter @voice-agent/web e2e:dashboard` (e2e/dashboard-run.mjs owns
// DB, servers, teardown; its own database, role and ports, so it cannot collide with the other e2e suites).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /dashboard\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3391", headless: true, screenshot: "only-on-failure", trace: "off" },
});
