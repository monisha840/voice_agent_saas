import { defineConfig } from "@playwright/test";

// Billing browser e2e. Run with `pnpm --filter @voice-agent/web e2e:billing` (e2e/billing-run.mjs owns DB, servers,
// teardown; it uses its own database, role and ports so it cannot collide with the account-security e2e).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /billing\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3291", headless: true, screenshot: "only-on-failure", trace: "off" },
});
