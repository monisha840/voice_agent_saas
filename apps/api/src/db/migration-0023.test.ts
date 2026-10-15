/**
 * Migration 0023 (knowledge base) on the development database's real path and its rollback, on a disposable database:
 * 0021 (where dev sits) -> 0022 -> 0023 with data in place, the documented rollback script, and re-applying 0023
 * afterwards. (The 0022 -> 0023 step, RLS and runtime-role isolation are in modules/knowledge/knowledge-migration.test.ts.)
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
const DOWN = join(HERE, "rollback", "0023_knowledge_base.down.sql");
const DB = "voice_agent_mig0023_path_test";
const KB_TABLES = ["knowledge_bases", "knowledge_documents", "knowledge_items"];

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

function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "va-mig23-"));
  mkdirSync(join(dir, "meta"));
  const j = journal();
  const cut = j.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`no migration ${lastTag}`);
  j.entries = j.entries.slice(0, cut + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(j));
  for (const e of j.entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function migrateTo(sql: postgres.Sql, tag: string) {
  const dir = migrationsUpTo(tag);
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** RLS flags and policies of the knowledge tables, for comparing states. */
async function kbCatalog(sql: postgres.Sql) {
  return sql`
    select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced,
      (select string_agg(p.polname || ':' || pg_get_expr(p.polqual, p.polrelid), ',' order by p.polname) from pg_policy p where p.polrelid = c.oid) policies
    from pg_class c where c.relname = any(${KB_TABLES}) and c.relkind = 'r' order by c.relname`;
}

describe("migration 0023 on the dev path (0021 -> 0022 -> 0023) and its rollback", () => {
  let admin: postgres.Sql;
  let org = "";
  let agent = "";

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

  const digest = async () =>
    (await admin`select md5(string_agg(t, '|' order by t)) d from (
       select 'o:' || row_to_json(o)::text t from organizations o
       union all select 'a:' || row_to_json(a)::text from agents a
       union all select 'l:' || row_to_json(l)::text from leads l
       union all select 's:' || row_to_json(s)::text from subscriptions s) x`)[0].d as string;

  it("upgrades from 0021 with data: two new journal rows, existing data untouched, knowledge tables protected", { timeout: 60_000 }, async () => {
    await migrateTo(admin, "0021_stream_grants");
    [{ id: org }] = await admin`insert into organizations (name, slug) values ('Path Co', 'path-co') returning id`;
    [{ id: agent }] = await admin`insert into agents (organization_id, name, persona_name) values (${org}, 'A', 'P') returning id`;
    const [project] = await admin`insert into projects (organization_id, name, location) values (${org}, 'P1', 'X') returning id`;
    await admin`insert into leads (organization_id, project_id, name, phone) values (${org}, ${project.id}, 'L', '+919000000001')`;
    await admin`insert into subscriptions (organization_id, plan_key, status, current_period_start, current_period_end)
                values (${org}, 'starter', 'active', now() - interval '1 day', now() + interval '29 days')`;
    await admin`insert into agent_knowledge_bindings (organization_id, agent_id, source_type, source_id) values (${org}, ${agent}, 'project', ${project.id})`;
    const before = await digest();
    const rows = (await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n as number;

    await migrateTo(admin, "0023_knowledge_base");

    expect((await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(rows + 2);
    expect(await digest()).toBe(before);
    for (const t of await kbCatalog(admin)) expect(t, t.relname).toMatchObject({ rls: true, forced: true });
    expect((await kbCatalog(admin)).map((t) => t.relname)).toEqual(KB_TABLES);
  });

  it("the rollback removes the knowledge tables and knowledge-base bindings only; re-applying restores the same protection", { timeout: 60_000 }, async () => {
    const protectedState = await kbCatalog(admin);
    const [kb] = await admin`insert into knowledge_bases (organization_id, name) values (${org}, 'KB') returning id`;
    await admin`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${org}, ${kb.id}, 'faq', 'Parking?', 'Yes')`;
    await admin`insert into agent_knowledge_bindings (organization_id, agent_id, source_type, source_id) values (${org}, ${agent}, 'knowledge_base', ${kb.id})`;
    const before = await digest();

    await admin.unsafe(readFileSync(DOWN, "utf8"));

    for (const t of KB_TABLES) expect((await admin`select to_regclass(${"public." + t}) r`)[0].r, t).toBeNull();
    const bindings = await admin`select source_type from agent_knowledge_bindings where agent_id = ${agent}`;
    expect(bindings.map((b) => b.source_type)).toEqual(["project"]); // the project binding is kept
    expect(await digest()).toBe(before);

    const when = journal().entries.find((e) => e.tag === "0023_knowledge_base")!.when;
    await admin`delete from drizzle.__drizzle_migrations where created_at = ${when}`;
    await migrateTo(admin, "0023_knowledge_base");
    expect(await kbCatalog(admin)).toEqual(protectedState);
  });
});
