import { loadEnv } from "../config/env.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { currentStore, type TenantScope } from "./tenant-context.js";

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
 *
 * DATABASE_URL MUST be the restricted runtime role (`voice_app`): not the table owner, not a superuser, no BYPASSRLS,
 * so row-level security applies to every statement. Migrations use DATABASE_MIGRATION_URL (db/migrate.ts).
 */
const poolOptions = {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  ssl: process.env.DATABASE_SSL === "require" ? ("require" as const) : undefined,
  prepare: process.env.DATABASE_PREPARE !== "false",
};

export const sql = postgres(databaseUrl, poolOptions);

/**
 * Administrative connection for fixtures, seeding and one-off scripts only. Absent in a production runtime: with no
 * DATABASE_ADMIN_URL, `runAsAdmin` / `adminDb` cannot reach the database at all.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
export const adminSql = adminUrl ? postgres(adminUrl, poolOptions) : null;

/** Copy the verified scope into the current transaction, as transaction-local settings. */
async function applyScope(tx: postgres.Sql, scope: TenantScope) {
  await tx`select set_config('app.organization_id', ${scope.organizationId ?? ""}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`;
}

function hasScope(scope: TenantScope | undefined): scope is TenantScope {
  return !!scope && !!(scope.organizationId || scope.userId);
}

/**
 * A lazily-executed statement with the small surface drizzle's postgres-js session uses (`await` and `.values()`).
 * Executing it opens a short transaction, sets the tenant scope, runs the statement and commits, so the scope can
 * never outlive the statement and never reaches another request through the pool.
 */
class ScopedQuery implements PromiseLike<unknown> {
  private promise: Promise<unknown> | null = null;
  constructor(
    private readonly client: postgres.Sql,
    private readonly scope: TenantScope,
    private readonly query: string,
    private readonly params: readonly unknown[] | undefined,
    private readonly options: unknown,
  ) {}
  private run(values: boolean): Promise<unknown> {
    return this.client.begin(async (tx) => {
      const t = tx as unknown as postgres.Sql;
      // Pipelined: the scope setting and the statement are sent back-to-back on the transaction's single connection
      // (one network round trip instead of two). PostgreSQL executes them strictly in order, so the statement can never
      // run before the scope is set; if setting the scope fails the statement is aborted by the failed transaction
      // (25P02) and the scope error is what propagates. Both are started (`execute`) explicitly because postgres.js
      // queries are lazy.
      const scopeQuery = t`select set_config('app.organization_id', ${this.scope.organizationId ?? ""}, true), set_config('app.user_id', ${this.scope.userId ?? ""}, true)`;
      const pending = t.unsafe(this.query, this.params as never, this.options as never);
      if (values) pending.values();
      scopeQuery.execute();
      pending.execute();
      try {
        await scopeQuery;
      } catch (err) {
        pending.then(undefined, () => undefined); // already failing; avoid an unhandled rejection
        throw err;
      }
      return pending;
    }) as Promise<unknown>;
  }
  values() {
    return this.run(true);
  }
  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.promise ??= this.run(false);
    return this.promise.then(onfulfilled, onrejected);
  }
}

function makeClient(): postgres.Sql {
  return new Proxy(sql, {
    get(target, prop) {
      if (prop === "unsafe") {
        return (query: string, params?: readonly unknown[], options?: unknown) => {
          const store = currentStore();
          if (store?.admin && adminSql) return adminSql.unsafe(query, params as never, options as never);
          if (hasScope(store?.scope)) return new ScopedQuery(target, store!.scope, query, params, options);
          // No scope: executes as a plain statement; row-level security denies every tenant-owned row.
          return target.unsafe(query, params as never, options as never);
        };
      }
      if (prop === "begin") {
        return (a: unknown, b?: unknown) => {
          const fn = (typeof a === "function" ? a : b) as (tx: postgres.Sql) => Promise<unknown>;
          const opts = typeof a === "function" ? undefined : (a as string);
          const store = currentStore();
          if (store?.admin && adminSql) return opts ? adminSql.begin(opts, fn as never) : adminSql.begin(fn as never);
          const scope = store?.scope;
          const wrapped = async (tx: postgres.Sql) => {
            if (hasScope(scope)) await applyScope(tx, scope);
            return fn(tx);
          };
          return opts ? target.begin(opts, wrapped as never) : target.begin(wrapped as never);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as postgres.Sql;
}

export const db = drizzle(makeClient(), { schema });

/** Always the administrative connection (fixtures, seeding, scripts). Unusable when none is configured. */
export const adminDb: typeof db = adminSql
  ? drizzle(adminSql, { schema })
  : (new Proxy({} as typeof db, {
      get() {
        throw new Error("DATABASE_ADMIN_URL is not configured: the administrative connection is unavailable.");
      },
    }) as typeof db);
