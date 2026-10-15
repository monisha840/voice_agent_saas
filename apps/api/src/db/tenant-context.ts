/**
 * Who a database statement is executed for. This is the application half of row-level security.
 *
 * The scope lives in AsyncLocalStorage and is copied into PostgreSQL by the database client (client.ts) as
 * TRANSACTION-LOCAL settings (`set_config(..., true)`), inside the same transaction as the statement. The RLS policies
 * read those settings. Nothing is ever stored on a pooled connection, so a connection reused by another tenant cannot
 * carry the previous tenant's identity.
 *
 * IMPORTANT: query builders execute when awaited, so the callback must `await` its query itself
 * (`runInTenant(scope, async () => await db.select()...)`); returning an un-awaited builder would run it outside the scope.
 *
 * A scope is only ever built from an already-verified source: the authenticated membership of the request, or the
 * organization a trusted record (call, invitation, phone number) belongs to. Never from request input.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantScope {
  /** The organization every tenant-owned row access is confined to. */
  organizationId?: string;
  /** The logged-in user, so they can list their own memberships/organizations before an organization is chosen. */
  userId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new Error(`Invalid ${what}`);
  return value;
}

interface Store {
  scope: TenantScope;
  /** Test/script only: route statements through the administrative connection (ignored unless one is configured). */
  admin: boolean;
}

const als = new AsyncLocalStorage<Store>();

export function currentStore(): Store | undefined {
  return als.getStore();
}

export function currentScope(): TenantScope | undefined {
  return als.getStore()?.scope;
}

/** Run `fn` with database access confined to `scope`. Nested scopes inherit what they do not override. */
export function runInTenant<T>(scope: TenantScope, fn: () => T): T {
  if (scope.organizationId) assertUuid(scope.organizationId, "organization id");
  if (scope.userId) assertUuid(scope.userId, "user id");
  const outer = als.getStore();
  const merged: TenantScope = { ...(outer?.scope ?? {}), ...scope };
  return als.run({ scope: merged, admin: false }, fn);
}

/**
 * Run `fn` on the administrative database connection (fixtures, seeding, one-off scripts). It only does anything when
 * DATABASE_ADMIN_URL is configured, which production runtimes must not set (see config validation).
 */
export function runAsAdmin<T>(fn: () => T): T {
  return als.run({ scope: {}, admin: true }, fn);
}
