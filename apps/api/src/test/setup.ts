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

// The Sales module is part of the product's call lifecycle; register it like app.ts does so tests that call
// services directly (no HTTP app) see the same behaviour.
import { registerSalesModule } from "../modules/sales/index.js";
registerSalesModule();
