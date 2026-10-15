#!/usr/bin/env node
// Self-cleaning browser e2e of the customer dashboard (overview, leads, calls, site visits) against a PRODUCTION web
// build.
//   pnpm --filter @voice-agent/web e2e:dashboard
// Own resources, distinct from e2e/run.mjs and billing-run.mjs: database voice_agent_dashboard_ui_test, role
// voice_app_dashuitest, API :4391, web :3391. Harness (and env vars) in prod-suite.mjs.
import { runProdSuite } from "./prod-suite.mjs";

process.exit(
  await runProdSuite({
    name: "dash",
    db: "voice_agent_dashboard_ui_test",
    role: "voice_app_dashuitest",
    rolePassword: "dashuitest_password_0123456789",
    apiPort: 4391,
    webPort: 3391,
    cookieName: "va_session_dashuitest",
    seedScript: "src/scripts/dashboard-ui-e2e-setup.ts",
    config: "playwright.dashboard.config.ts",
  }),
);
