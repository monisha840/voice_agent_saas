import { loadEnv } from "../config/env.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

loadEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
}

/**
 * Portable across local Docker Postgres and hosted Postgres (e.g. Supabase):
 * everything comes from DATABASE_URL (which may carry ?sslmode=require).
 *  - DATABASE_SSL=require      force TLS when the URL does not say so
 *  - DATABASE_PREPARE=false    required behind a transaction-mode pooler (PgBouncer / Supabase :6543)
 *  - DATABASE_POOL_MAX         connection pool size (default 10)
 * Migrations should use a DIRECT connection: set DATABASE_MIGRATION_URL (see db/migrate.ts).
 */
export const sql = postgres(databaseUrl, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  prepare: process.env.DATABASE_PREPARE !== "false",
});
export const db = drizzle(sql, { schema });
