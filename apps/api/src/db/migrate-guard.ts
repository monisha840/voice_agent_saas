/**
 * Safety guard for the migration runner (see migrate.ts and docs/security/migration-reconciliation.md).
 *
 * Incident: a test runner exported DATABASE_URL pointing at a throw-away database while DATABASE_MIGRATION_URL (loaded
 * from the developer's .env, which dotenv never overrides) still pointed at the development database, so "migrate"
 * silently applied pending migrations to the wrong database. The runner now refuses that mismatch unless the operator
 * names the database being migrated in MIGRATION_TARGET_CONFIRM.
 */

export interface MigrationTarget {
  /** The connection string that will be used (never logged: it contains the password). */
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** host:port/database, safe to print. */
  label: string;
}

function parse(raw: string, name: string): MigrationTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid connection URL.`);
  }
  const host = u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]" ? "127.0.0.1" : u.hostname;
  const port = u.port || "5432";
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(u.username);
  return { url: raw, host, port, database, user, label: `${host}:${port}/${database}` };
}

/** Decide which database to migrate, or throw when the environment is ambiguous. Pure: reads only `env`. */
export function resolveMigrationTarget(env: Record<string, string | undefined>): MigrationTarget {
  const migrationUrl = env.DATABASE_MIGRATION_URL || undefined;
  const runtimeUrl = env.DATABASE_URL || undefined;
  const chosen = migrationUrl || runtimeUrl;
  if (!chosen) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
  const target = parse(chosen, migrationUrl ? "DATABASE_MIGRATION_URL" : "DATABASE_URL");

  if (migrationUrl && runtimeUrl) {
    const runtime = parse(runtimeUrl, "DATABASE_URL");
    const differs = runtime.host !== target.host || runtime.port !== target.port || runtime.database !== target.database;
    if (differs && env.MIGRATION_TARGET_CONFIRM !== target.database) {
      throw new Error(
        `Refusing to migrate: DATABASE_URL targets ${runtime.label} but DATABASE_MIGRATION_URL targets ${target.label}. ` +
          `If ${target.database} really is the database to migrate, re-run with MIGRATION_TARGET_CONFIRM=${target.database}.`
      );
    }
  }
  return target;
}
