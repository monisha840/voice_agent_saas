/**
 * Shared per-file test setup. Loads env, then points every test at the
 * isolated test database (never the dev database): see test-database.ts and
 * global-setup.ts. Only external providers (Exotel/Sarvam) are mocked; our
 * own Postgres is real.
 */
import { loadEnv } from "../config/env.js";
import { getTestDatabaseUrl } from "./test-database.js";

loadEnv();
// Cheap password hashing keeps auth tests fast (the cost is stored in each hash).
process.env.AUTH_SCRYPT_N = "1024";
process.env.DATABASE_URL = getTestDatabaseUrl();
// Tests must never depend on (or send) a real webhook secret from .env.
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
// Nor a real provider key: a key left in .env would make the "not configured" tests call the real service. The opt-in
// integration tests (SARVAM_*_INTEGRATION=1) are the only runs that keep it.
const integrationRun = Object.entries(process.env).some(([name, value]) => name.endsWith("_INTEGRATION") && value === "1");
if (!integrationRun) process.env.SARVAM_API_KEY = "";

// The Sales module is part of the product's call lifecycle; register it like app.ts does so tests that call
// services directly (no HTTP app) see the same behaviour.
import { registerSalesModule } from "../modules/sales/index.js";
registerSalesModule();

// The cost/abuse guards (concurrent calls, daily quota, call length, silence) are real production defaults; most
// tests create many calls in one organization and run scripted sessions, so they start with the guards out of the way.
// The limit tests set their own values explicitly.
process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
process.env.MAX_CALL_DURATION_MS = "0";
process.env.SILENCE_TIMEOUT_MS = "0";
// The wait before an agent-ended call hangs up is a production default; tests end calls at once unless they test it.
process.env.CLOSING_GRACE_MS = "0";
process.env.CLOSING_GRACE_AFTER_GOODBYE_MS = "0";
