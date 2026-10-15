/**
 * Migration 0023 (knowledge base) against a disposable PostgreSQL database: the exact upgrade from 0022 (the schema
 * immediately before it) with data in place, catalog state (forced RLS, policy, constraints, indexes), and tenant
 * isolation as the RESTRICTED runtime role (not the owner).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { adminSql } from "../../db/client.js";
import { TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "../../test/test-database.js";

const MIGRATIONS = join(fileURLToPath(new URL("../../db/", import.meta.url)), "migrations");
const DB = "voice_agent_kb_mig0023_test";

function urlFor(db: string, user?: { name: string; password: string }) {
  const o = adminSql!.options as unknown as { host: string[]; port: number[]; user: string; pass: string };
  const u = new URL("postgresql://localhost");
  u.hostname = o.host[0];
  u.port = String(o.port[0]);
  u.username = user?.name ?? o.user;
  u.password = user?.password ?? o.pass;
  u.pathname = `/${db}`;
  return u.toString();
}

function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "va-kbmig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`no migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, cut + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

let admin: postgres.Sql;
let app: postgres.Sql;
let orgA = "";
let orgB = "";
let agentA = "";

beforeAll(async () => {
  const maint = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.unsafe(`CREATE DATABASE "${DB}"`);
  await maint.end();
  admin = postgres(urlFor(DB), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await app?.end();
  await admin.end();
  const maint = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.end();
});

describe("migration 0023 knowledge base", () => {
  it("upgrades from 0022 with data in place: exactly one new migration row, existing rows untouched", { timeout: 60_000 }, async () => {
    const to0022 = migrationsUpTo("0022_billing_grants_hardening");
    await migrate(drizzle(admin), { migrationsFolder: to0022 });
    rmSync(to0022, { recursive: true, force: true });
    await admin.unsafe(`ALTER ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'`);

    [{ id: orgA }] = await admin`insert into organizations (name, slug) values ('KB Org A', 'kb-org-a') returning id`;
    [{ id: orgB }] = await admin`insert into organizations (name, slug) values ('KB Org B', 'kb-org-b') returning id`;
    [{ id: agentA }] = await admin`insert into agents (organization_id, name, persona_name) values (${orgA}, 'A', 'P') returning id`;
    const [project] = await admin`insert into projects (organization_id, name, location) values (${orgA}, 'P1', 'X') returning id`;
    await admin`insert into agent_knowledge_bindings (organization_id, agent_id, source_type, source_id) values (${orgA}, ${agentA}, 'project', ${project.id})`;
    const digest = async () =>
      (await admin`select md5(string_agg(t, '|' order by t)) d from (
         select 'o:' || row_to_json(o)::text t from organizations o
         union all select 'a:' || row_to_json(a)::text from agents a
         union all select 'b:' || row_to_json(b)::text from agent_knowledge_bindings b) x`)[0].d as string;
    const before = await digest();
    const rowsBefore = (await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n as number;

    const to0023 = migrationsUpTo("0023_knowledge_base");
    await migrate(drizzle(admin), { migrationsFolder: to0023 });
    await migrate(drizzle(admin), { migrationsFolder: to0023 }); // re-running is a no-op
    rmSync(to0023, { recursive: true, force: true });

    expect((await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(rowsBefore + 1);
    expect(await digest()).toBe(before);
  });

  it("creates the three tables with FORCED row-level security, the tenant policy, constraints and the search index", async () => {
    const rows = await admin`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced,
        (select string_agg(polname, ',') from pg_policy p where p.polrelid = c.oid) policies
      from pg_class c where c.relname in ('knowledge_bases','knowledge_documents','knowledge_items') and c.relkind = 'r' order by 1`;
    expect(rows).toEqual([
      { relname: "knowledge_bases", rls: true, forced: true, policies: "tenant_isolation" },
      { relname: "knowledge_documents", rls: true, forced: true, policies: "tenant_isolation" },
      { relname: "knowledge_items", rls: true, forced: true, policies: "tenant_isolation" },
    ]);
    const idx = await admin`select indexdef from pg_indexes where indexname = 'knowledge_items_search_idx'`;
    expect(idx[0].indexdef).toMatch(/USING gin \(search\)/);
    const priv = async (t: string, p: string) => (await admin`select has_table_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${p}) ok`)[0].ok as boolean;
    for (const t of ["knowledge_bases", "knowledge_documents", "knowledge_items"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await priv(t, p), `${t} ${p}`).toBe(true);
    }
  });

  it("as the restricted runtime role: no scope sees nothing; a scope sees and writes only its own organization", async () => {
    app = postgres(urlFor(DB, { name: TEST_RUNTIME_ROLE, password: TEST_RUNTIME_PASSWORD }), { max: 1, onnotice: () => {} });
    const asOrg = <T>(org: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${org}, true)`;
        return fn(tx);
      });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

    const [kbA] = await asOrg(orgA, (tx) => tx`insert into knowledge_bases (organization_id, name) values (${orgA}, 'A base') returning id`);
    await asOrg(orgA, (tx) => tx`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${orgA}, ${kbA.id}, 'faq', 'Parking?', 'Yes, free parking.')`);
    await asOrg(orgB, (tx) => tx`insert into knowledge_bases (organization_id, name) values (${orgB}, 'B base')`);

    // no tenant scope: nothing is visible
    expect((await app`select count(*)::int n from knowledge_items`)[0].n).toBe(0);
    expect((await app`select count(*)::int n from knowledge_bases`)[0].n).toBe(0);
    // each organization sees only itself, including through the full-text index
    expect((await asOrg(orgB, (tx) => tx`select count(*)::int n from knowledge_items where search @@ to_tsquery('simple', 'parking')`))[0].n).toBe(0);
    expect((await asOrg(orgA, (tx) => tx`select count(*)::int n from knowledge_items where search @@ to_tsquery('simple', 'parking')`))[0].n).toBe(1);
    expect((await asOrg(orgB, (tx) => tx`select name from knowledge_bases`)).map((r) => r.name)).toEqual(["B base"]);
    // WITH CHECK: org B cannot write a row owned by org A, nor move A's row, nor see it to update or delete
    expect(await code(asOrg(orgB, (tx) => tx`insert into knowledge_bases (organization_id, name) values (${orgA}, 'Planted')`))).toBe("42501");
    expect((await asOrg(orgB, (tx) => tx`update knowledge_items set body = 'hacked' returning id`)).length).toBe(0);
    expect((await asOrg(orgB, (tx) => tx`delete from knowledge_bases where id = ${kbA.id} returning id`)).length).toBe(0);
    // composite foreign keys: an item cannot point at another organization's knowledge base even with A's scope
    const [kbB] = await admin`select id from knowledge_bases where organization_id = ${orgB}`;
    expect(await code(asOrg(orgA, (tx) => tx`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${orgA}, ${kbB.id}, 'faq', 'x', 'y')`))).toBe("23503");
    // check constraints
    expect(await code(asOrg(orgA, (tx) => tx`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${orgA}, ${kbA.id}, 'document', 'x', 'y')`))).toBe("23514");
    expect(await code(asOrg(orgA, (tx) => tx`insert into knowledge_documents (organization_id, knowledge_base_id, filename, content_type, size_bytes, sha256, status) values (${orgA}, ${kbA.id}, 'a.txt', 'text/plain', 1, 'x', 'stuck')`))).toBe("23514");
  });

  it("deleting a document removes its passages; deleting a knowledge base removes its documents and items (referential integrity)", async () => {
    const [kb] = await admin`insert into knowledge_bases (organization_id, name) values (${orgA}, 'Cascade') returning id`;
    const [doc] = await admin`insert into knowledge_documents (organization_id, knowledge_base_id, filename, content_type, size_bytes, sha256, status) values (${orgA}, ${kb.id}, 'd.txt', 'text/plain', 3, 'abc', 'ready') returning id`;
    await admin`insert into knowledge_items (organization_id, knowledge_base_id, document_id, kind, body) values (${orgA}, ${kb.id}, ${doc.id}, 'document', 'passage')`;
    await admin`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${orgA}, ${kb.id}, 'info', 't', 'b')`;
    await admin`delete from knowledge_documents where id = ${doc.id}`;
    expect((await admin`select kind from knowledge_items where knowledge_base_id = ${kb.id}`).map((r) => r.kind)).toEqual(["info"]);
    await admin`delete from knowledge_bases where id = ${kb.id}`;
    expect((await admin`select count(*)::int n from knowledge_items where knowledge_base_id = ${kb.id}`)[0].n).toBe(0);
    // an organization with knowledge cannot be deleted out from under it (restrict, like every tenant table)
    expect(await admin`delete from organizations where id = ${orgA}`.then(() => "ok", (e: { code?: string }) => e.code)).toBe("23503");
  });
});
