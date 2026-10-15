import { defineConfig } from "@playwright/test";

// Browser e2e of the account-security UI. Run with pnpm --filter @voice-agent/web e2e (e2e/run.mjs owns DB, servers, teardown).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100", headless: true, screenshot: "only-on-failure", trace: "off" },
});
