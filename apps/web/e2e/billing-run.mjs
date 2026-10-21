#!/usr/bin/env node
// Self-cleaning browser e2e of the billing UI against a PRODUCTION web build.
//   pnpm --filter @voice-agent/web e2e:billing
// Own resources, distinct from e2e/run.mjs and dashboard-run.mjs: database voice_agent_billing_ui_test, role
// voice_app_billuitest, API :4291, web :3291. Harness (and env vars) in prod-suite.mjs.
import { runProdSuite } from "./prod-suite.mjs";

process.exit(
  await runProdSuite({
    name: "bill",
    db: "voice_agent_billing_ui_test",
    role: "voice_app_billuitest",
    rolePassword: "billuitest_password_0123456789",
    apiPort: 4291,
    webPort: 3291,
    cookieName: "va_session_billuitest",
    seedScript: "src/scripts/billing-ui-e2e-setup.ts",
    config: "playwright.billing.config.ts",
  }),
);
