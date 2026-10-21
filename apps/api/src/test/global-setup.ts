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
import { getTestDatabaseUrl, getTestRuntimeUrl, TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "./test-database.js";

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
  // The migration created the NOLOGIN runtime role; like a real deployment, give it a login out of band.
  await sql.unsafe(`ALTER ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
  await sql.end();

  // The application runs as the restricted role; seeding (a provisioning step) uses the administrative connection.
  process.env.DATABASE_URL = getTestRuntimeUrl();
  process.env.DATABASE_ADMIN_URL = testUrl;
  // Workers inherit this environment: pin the owner URL so they can derive both identities from it.
  process.env.TEST_DATABASE_URL = testUrl;
  const { runSeed } = await import("../scripts/seed.js");
  const { runAsAdmin } = await import("../db/tenant-context.js");
  await runAsAdmin(() => runSeed());
  const { sql: appSql, adminSql: runtimeAdminSql } = await import("../db/client.js");
  await appSql.end();
  await runtimeAdminSql?.end();
}
