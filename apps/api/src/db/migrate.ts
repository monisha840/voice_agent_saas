/**
 * Runs all pending Drizzle migrations against DATABASE_URL.
 * Usage: pnpm --filter @voice-agent/api db:migrate
 */

import { loadEnv } from "../config/env.js";
loadEnv();

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveMigrationTarget } from "./migrate-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer a direct (non-pooled) connection for migrations when one is provided (e.g. Supabase). The guard refuses an
// ambiguous environment (DATABASE_URL and DATABASE_MIGRATION_URL naming different databases) unless
// MIGRATION_TARGET_CONFIRM=<database name> is set.
const target = resolveMigrationTarget(process.env);

async function main() {
  console.log(`Migration target: ${target.label} (user: ${target.user || "(none)"})`);
  const migrationClient = postgres(target.url, { max: 1, ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined });
  const db = drizzle(migrationClient);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: join(__dirname, "migrations") });
  console.log("Migrations complete.");

  await migrationClient.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
