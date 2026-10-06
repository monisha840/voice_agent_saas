/**
 * Runs once per test run: (re)creates the isolated test database, applies
 * every migration, and seeds the demo data the existing tests rely on.
 * Never touches the development database.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "../config/env.js";
import { getTestDatabaseUrl } from "./test-database.js";

export default async function setup() {
  loadEnv();
  process.env.AUTH_SCRYPT_N = "1024"; // fast hashing for seeded test users
  const testUrl = getTestDatabaseUrl();
  const dbName = new URL(testUrl).pathname.slice(1);

  // Create the database if it does not exist yet (connect to the maintenance DB).
  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const adminSql = postgres(admin.toString(), { max: 1 });
  const exists = await adminSql`select 1 from pg_database where datname = ${dbName}`;
  if (exists.length === 0) await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminSql.end();

  // Clean slate -> migrate -> seed.
  const sql = postgres(testUrl, { max: 1 });
  await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  const here = dirname(fileURLToPath(import.meta.url));
  await migrate(drizzle(sql), { migrationsFolder: join(here, "../db/migrations") });
  await sql.end();

  process.env.DATABASE_URL = testUrl;
  const { runSeed } = await import("../scripts/seed.js");
  await runSeed();
  const { sql: appSql } = await import("../db/client.js");
  await appSql.end();
}
