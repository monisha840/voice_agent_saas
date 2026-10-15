#!/usr/bin/env node
// Self-cleaning browser e2e of the knowledge base, agent knowledge binding and the test playground, against a
// PRODUCTION web build.
//   pnpm --filter @voice-agent/web e2e:knowledge
// Own resources, distinct from every other suite: database voice_agent_kb_ui_test, role voice_app_kbuitest,
// API :4491, web :3491. Harness (and env vars) in prod-suite.mjs.
import { runProdSuite } from "./prod-suite.mjs";

process.exit(
  await runProdSuite({
    name: "kb",
    db: "voice_agent_kb_ui_test",
    role: "voice_app_kbuitest",
    rolePassword: "kbuitest_password_0123456789",
    apiPort: 4491,
    webPort: 3491,
    cookieName: "va_session_kbuitest",
    seedScript: "src/scripts/kb-ui-e2e-setup.ts",
    config: "playwright.knowledge.config.ts",
  }),
);
