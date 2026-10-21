/**
 * Startup self-check of the database identity the runtime connected as. Row-level security only protects tenants if
 * the application cannot bypass it, so a runtime connected as a superuser, a BYPASSRLS role or a table owner (with
 * FORCE ROW LEVEL SECURITY this last still applies policies, but an owner can also disable them) is a
 * misconfiguration that must stop a production boot.
 */
import type postgres from "postgres";
import { sql as runtimeSql } from "../db/client.js";

export interface RuntimeRoleReport {
  role: string;
  problems: string[];
}

export async function inspectRuntimeRole(sql: postgres.Sql = runtimeSql): Promise<RuntimeRoleReport> {
  const rows = await sql`
    select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           (select count(*)::int from pg_tables t where t.schemaname = 'public' and t.tableowner = r.rolname) as owned_tables,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) as protected_tables
    from pg_roles r where r.rolname = current_user`;
  const me = rows[0];
  const problems: string[] = [];
  if (!me) return { role: "unknown", problems: ["could not inspect the connected database role"] };
  if (me.rolsuper) problems.push("is a SUPERUSER (bypasses every row-level security policy)");
  if (me.rolbypassrls) problems.push("has BYPASSRLS");
  if (me.rolcreaterole) problems.push("can CREATE ROLE");
  if (me.rolcreatedb) problems.push("can CREATE DATABASE");
  if (me.owned_tables > 0) problems.push(`owns ${me.owned_tables} table(s) (an owner can disable row-level security)`);
  if (me.protected_tables === 0) problems.push("no table has row-level security enabled: migration 0012 has not been applied");
  return { role: me.rolname as string, problems };
}
