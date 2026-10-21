/**
 * Migration 0024 (number management) on a disposable database: the dev path 0021 -> 0024 with numbers and calls in
 * place (existing numbers stay assigned and become "routing on", calls are untouched), RLS on agent_phone_numbers and
 * calls unchanged, the resolver's column grant unchanged, the documented rollback, and re-applying 0024.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { adminSql } from "./client.js";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const MIGRATIONS = join(HERE, "migrations");
const DOWN = join(HERE, "rollback", "0024_number_management.down.sql");
const DB = "voice_agent_mig0024_path_test";
const NEW_NUMBER_COLUMNS = [
  "last_inbound_at",
  "last_refused_at",
  "last_refused_call_id",
  "last_refused_reason",
  "provider_checked_at",
  "provider_detail",
  "provider_status",
  "refused_count",
  "routing_enabled",
  "updated_at",
];

function urlFor(db: string) {
  const o = adminSql!.options as unknown as { host: string[]; port: number[]; user: string; pass: string };
  const u = new URL("postgresql://localhost");
  u.hostname = o.host[0];
  u.port = String(o.port[0]);
  u.username = o.user;
  u.password = o.pass;
  u.pathname = `/${db}`;
  return u.toString();
}

const journal = () =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };

async function migrateTo(sql: postgres.Sql, lastTag: string) {
  const dir = mkdtempSync(join(tmpdir(), "va-mig24-"));
  try {
    mkdirSync(join(dir, "meta"));
    const j = journal();
    const cut = j.entries.findIndex((e) => e.tag === lastTag);
    if (cut < 0) throw new Error(`no migration ${lastTag}`);
    j.entries = j.entries.slice(0, cut + 1);
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(j));
    for (const e of j.entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("migration 0024 on the dev path (0021 -> 0024) and its rollback", () => {
  let admin: postgres.Sql;
  let org = "";
  let number = "";

  beforeAll(async () => {
    const maint = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
    await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await maint.unsafe(`CREATE DATABASE "${DB}"`);
    await maint.end();
    admin = postgres(urlFor(DB), { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin.end();
    const maint = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
    await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await maint.end();
  });

  const security = async () => ({
    tables: await admin`select relname, relrowsecurity rls, relforcerowsecurity forced from pg_class
                        where relname in ('agent_phone_numbers', 'calls') and relkind = 'r' order by relname`,
    policies: await admin`select polrelid::regclass::text t, polname, pg_get_expr(polqual, polrelid) q from pg_policy
                          where polrelid in ('agent_phone_numbers'::regclass, 'calls'::regclass) order by 1, 2`,
    resolverColumns: await admin`select column_name from information_schema.column_privileges
                                 where grantee = 'voice_resolver' and table_name = 'agent_phone_numbers' order by 1`,
  });
  const numberCols = async () =>
    (await admin`select column_name from information_schema.columns where table_name = 'agent_phone_numbers' order by 1`).map((r) => r.column_name as string);
  const digest = async () =>
    (await admin`select md5(string_agg(t, '|' order by t)) d from (
       select 'o:' || row_to_json(o)::text t from organizations o
       union all select 'a:' || row_to_json(a)::text from agents a
       union all select 'n:' || id || organization_id || agent_id || phone_number || coalesce(label, '') from agent_phone_numbers
       union all select 'c:' || id || status || call_type || coalesce(counterparty_number, '') from calls) x`)[0].d as string;

  it("upgrades with data: numbers keep their agent and default to routing on; calls and security unchanged", { timeout: 90_000 }, async () => {
    await migrateTo(admin, "0021_stream_grants");
    [{ id: org }] = await admin`insert into organizations (name, slug) values ('Num Co', 'num-co') returning id`;
    const [agent] = await admin`insert into agents (organization_id, name, persona_name) values (${org}, 'A', 'P') returning id`;
    number = "+918012345678";
    await admin`insert into agent_phone_numbers (organization_id, agent_id, phone_number, label) values (${org}, ${agent.id}, ${number}, 'Main')`;
    await admin`insert into calls (organization_id, agent_id, call_type, status, counterparty_number) values (${org}, ${agent.id}, 'inbound', 'completed', '+919000000001')`;
    await migrateTo(admin, "0023_knowledge_base");
    const before = await digest();
    const secBefore = await security();
    const rows = (await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n as number;

    await migrateTo(admin, "0024_number_management");

    expect((await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(rows + 1);
    expect(await digest()).toBe(before);
    expect(await security()).toEqual(secBefore);
    const [n] = await admin`select routing_enabled, refused_count, updated_at from agent_phone_numbers where phone_number = ${number}`;
    expect(n.routing_enabled).toBe(true);
    expect(n.refused_count).toBe(0);
    expect(n.updated_at).toBeTruthy();
    expect((await admin`select line_number from calls`)[0].line_number).toBeNull();
    expect((await admin`select indexname from pg_indexes where indexname = 'calls_org_line_created_idx'`).length).toBe(1);
    // The inbound resolver still works and still sees only (organization_id, phone_number).
    expect((await admin`select app_resolve_phone_number_org(${number}) org`)[0].org).toBe(org);
    // Re-running is a no-op.
    await migrateTo(admin, "0024_number_management");
    expect((await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(rows + 1);
  });

  it("the rollback drops only the 0024 columns and index, keeping numbers and calls; re-applying restores them", { timeout: 90_000 }, async () => {
    const colsAfter = await numberCols();
    for (const c of NEW_NUMBER_COLUMNS) expect(colsAfter).toContain(c);
    await admin`update agent_phone_numbers set routing_enabled = false, refused_count = 3 where phone_number = ${number}`;
    await admin`update calls set line_number = ${number}`;
    const secBefore = await security();
    const before = await digest();

    await admin.unsafe(readFileSync(DOWN, "utf8"));

    const colsDown = await numberCols();
    for (const c of NEW_NUMBER_COLUMNS) expect(colsDown).not.toContain(c);
    expect((await admin`select column_name from information_schema.columns where table_name = 'calls' and column_name = 'line_number'`).length).toBe(0);
    expect(await digest()).toBe(before);
    expect(await security()).toEqual(secBefore);
    expect((await admin`select app_resolve_phone_number_org(${number}) org`)[0].org).toBe(org);

    const when = journal().entries.find((e) => e.tag === "0024_number_management")!.when;
    await admin`delete from drizzle.__drizzle_migrations where created_at = ${when}`;
    await migrateTo(admin, "0024_number_management");
    expect(await numberCols()).toEqual(colsAfter);
    expect(await security()).toEqual(secBefore);
  });
});
