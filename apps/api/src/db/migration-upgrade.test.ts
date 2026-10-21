/**
 * Migration safety against a disposable PostgreSQL database: a clean install, an in-place upgrade from the schema
 * before row-level security (migration 0011) with data already in it, and the documented emergency rollback.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { adminSql } from "./client.js";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "../test/test-database.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS = join(here, "migrations");
const ROLLBACK = join(here, "rollback", "0012_row_level_security.down.sql");
const REENABLE = join(here, "rollback", "0012_row_level_security.reenable.sql");
// Per-process name so concurrent test runs on the same server cannot drop each other's database.
const DB = `voice_agent_upgrade_test_${process.pid}`;

let work: string;
let adminUrl: string;
let runtimeUrl: string;

function urlFor(db: string, user?: { name: string; password: string }) {
  // The administrative (owner) credentials of the test server, taken from the live admin connection; only the
  // database name and, optionally, the user change.
  const o = adminSql!.options as unknown as { host: string[]; port: number[]; user: string; pass: string };
  const u = new URL("postgresql://localhost");
  u.hostname = o.host[0];
  u.port = String(o.port[0]);
  u.username = o.user;
  u.password = o.pass;
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** A migrations folder holding only the migrations up to (and including) `lastIdx`. */
function partialMigrations(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), "va-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function freshDatabase() {
  const maint = postgres(urlFor("postgres"), { max: 1 });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.unsafe(`CREATE DATABASE "${DB}"`);
  await maint.end();
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "va-up-"));
  adminUrl = urlFor(DB);
  runtimeUrl = urlFor(DB, { name: TEST_RUNTIME_ROLE, password: TEST_RUNTIME_PASSWORD });
});

afterAll(async () => {
  const maint = postgres(urlFor("postgres"), { max: 1 });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.end();
  rmSync(work, { recursive: true, force: true });
});

describe("upgrade from the schema before row-level security", () => {
  it("applies 0012+ on top of existing data without losing or altering any of it", { timeout: 30_000 }, async () => {
    await freshDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    try {
      const before = partialMigrations(11);
      await migrate(drizzle(admin), { migrationsFolder: before });
      rmSync(before, { recursive: true, force: true });

      // Data written by the pre-RLS version of the application.
      const [org] = await admin`insert into organizations (name, slug) values ('Legacy Co', 'legacy-co') returning id`;
      const [user] = await admin`insert into users (email, name, password_hash) values ('legacy@example.test', 'Legacy', 'scrypt$1$8$1$AAAA$AAAA') returning id`;
      await admin`insert into memberships (organization_id, user_id, role) values (${org.id}, ${user.id}, 'OWNER')`;
      const [project] = await admin`insert into projects (organization_id, name, location) values (${org.id}, 'Legacy Heights', 'Chennai') returning id`;
      await admin`insert into leads (organization_id, project_id, name, phone) values (${org.id}, ${project.id}, 'Old Lead', '+919000000099')`;
      const counts = async () => {
        const out: Record<string, number> = {};
        for (const t of ["organizations", "users", "memberships", "projects", "leads"]) {
          out[t] = (await admin.unsafe(`select count(*)::int as n from ${t}`))[0].n as number;
        }
        return out;
      };
      const snapshot = await counts();

      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS }); // 0012, 0013, ...
      await admin.unsafe(`ALTER ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'`);

      expect(await counts()).toEqual(snapshot);
      const [lead] = await admin`select name, organization_id from leads where name = 'Old Lead'`;
      expect(lead.organization_id).toBe(org.id);

      // The application, as the restricted role, sees the migrated data only inside the owning organization.
      const app = postgres(runtimeUrl, { max: 1 });
      try {
        expect((await app`select count(*)::int as n from leads`)[0].n).toBe(0);
        const scoped = await app.begin(async (tx) => {
          await tx`select set_config('app.organization_id', ${org.id}, true)`;
          return tx`select name from leads`;
        });
        expect(scoped.map((r) => r.name)).toEqual(["Old Lead"]);
      } finally {
        await app.end();
      }

      // Re-running the migrations is a no-op (idempotent), and 0012's SQL is itself re-runnable.
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      await admin.unsafe(readFileSync(join(MIGRATIONS, "0012_row_level_security.sql"), "utf8").replace(/--> statement-breakpoint/g, ""));
      expect(await counts()).toEqual(snapshot);
    } finally {
      await admin.end();
    }
  });

  it("a clean install reaches the same protected state", { timeout: 30_000 }, async () => {
    await freshDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      const rows = await admin`
        select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity`;
      expect(rows[0].n).toBeGreaterThanOrEqual(19);
    } finally {
      await admin.end();
    }
  });
});

describe("documented emergency rollback of 0012", () => {
  it("removes database enforcement without touching data, and re-running the migration restores it", { timeout: 30_000 }, async () => {
    await freshDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      await admin.unsafe(`ALTER ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
      const [org] = await admin`insert into organizations (name, slug) values ('RB Co', 'rb-co') returning id`;
      await admin`insert into projects (organization_id, name, location) values (${org.id}, 'RB', 'X')`;

      const app = postgres(runtimeUrl, { max: 1 });
      try {
        expect((await app`select count(*)::int as n from projects`)[0].n).toBe(0); // enforced
        await admin.unsafe(readFileSync(ROLLBACK, "utf8"));
        expect((await app`select count(*)::int as n from projects`)[0].n).toBe(1); // enforcement removed (this is the danger)
        await admin.unsafe(readFileSync(join(MIGRATIONS, "0012_row_level_security.sql"), "utf8").replace(/--> statement-breakpoint/g, ""));
        expect((await app`select count(*)::int as n from projects`)[0].n).toBe(0); // enforced again
      } finally {
        await app.end();
      }
      expect((await admin`select count(*)::int as n from projects`)[0].n).toBe(1); // data never touched
    } finally {
      await admin.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Catalog equivalence (additive): every path to the current head must produce the same protected schema.
// ---------------------------------------------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

/** A normalised, comparable description of everything security relevant in the public schema. */
async function catalog(sql: Sql) {
  const cols = await sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public' order by 1, 2`;
  const tables = await sql`
    select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner,
           coalesce((select string_agg(a, ',' order by a) from unnest(c.relacl::text[]) a), '') as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r', 'S') order by 1`;
  const policies = await sql`
    select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies
    where schemaname = 'public' order by 1, 2`;
  const functions = await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_userbyid(p.proowner) as owner,
           p.prosecdef as secdef, coalesce(p.proacl::text, '') as acl, md5(p.prosrc) as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' order by 1, 2`;
  const triggers = await sql`
    select tgrelid::regclass::text as tbl, tgname, tgenabled from pg_trigger where not tgisinternal order by 1, 2`;
  const constraints = await sql`
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
    where connamespace = 'public'::regnamespace order by 1, 2`;
  const indexes = await sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`;
  const plans = await sql`select key, entitlements::text as e from plans order by 1`;
  return {
    cols: [...cols], tables: [...tables], policies: [...policies], functions: [...functions],
    triggers: [...triggers], constraints: [...constraints], indexes: [...indexes], plans: [...plans],
  };
}

async function appliedHashes(sql: Sql) {
  return [...(await sql`select hash, created_at from drizzle.__drizzle_migrations order by id`)];
}

describe("clean install, upgrade and rollback reach the same catalog", () => {
  it("upgrade from 0011 produces exactly the clean-install catalog (tables, columns, policies, grants, functions, triggers)", { timeout: 30_000 }, async () => {
    await freshDatabase();
    let clean: Awaited<ReturnType<typeof catalog>>;
    let cleanApplied: Awaited<ReturnType<typeof appliedHashes>>;
    const a = postgres(adminUrl, { max: 1 });
    try {
      await migrate(drizzle(a), { migrationsFolder: MIGRATIONS });
      clean = await catalog(a);
      cleanApplied = await appliedHashes(a);
    } finally {
      await a.end();
    }

    await freshDatabase();
    const b = postgres(adminUrl, { max: 1 });
    try {
      const before = partialMigrations(11);
      await migrate(drizzle(b), { migrationsFolder: before });
      rmSync(before, { recursive: true, force: true });
      await migrate(drizzle(b), { migrationsFolder: MIGRATIONS });
      const upgraded = await catalog(b);
      for (const key of Object.keys(clean) as Array<keyof typeof clean>) {
        expect(upgraded[key], `catalog section ${key}`).toEqual(clean[key]);
      }
      // The migration journal has the same applied set (journal idx 16 intentionally does not exist).
      expect(await appliedHashes(b)).toEqual(cleanApplied);
      const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number }> };
      expect(cleanApplied.length).toBe(journal.entries.length);
      expect(journal.entries.some((e) => e.idx === 16)).toBe(false);
    } finally {
      await b.end();
    }
  });

  it("re-running the migrator is a no-op: same catalog, same journal rows", { timeout: 30_000 }, async () => {
    await freshDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      const c1 = await catalog(admin);
      const h1 = await appliedHashes(admin);
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      expect(await catalog(admin)).toEqual(c1);
      expect(await appliedHashes(admin)).toEqual(h1);
    } finally {
      await admin.end();
    }
  });

  it("the 0012 emergency rollback is partial; the re-enable script restores the head catalog (re-applying 0012 widens grants)", { timeout: 30_000 }, async () => {
    await freshDatabase();
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
      const head = await catalog(admin);

      await admin.unsafe(readFileSync(ROLLBACK, "utf8"));
      const rolledBack = await catalog(admin);
      // Rollback only disables RLS on the tables 0012 covered; policies/data/later tables are left alone.
      const rlsOff = rolledBack.tables.filter((t) => head.tables.find((h) => h.relname === t.relname)?.rls && !t.rls).map((t) => t.relname);
      expect(rlsOff).toContain("projects");
      expect(rlsOff).not.toContain("security_events");
      expect(rlsOff).not.toContain("subscriptions"); // 0019 tables are not covered by the 0012 rollback
      expect(rolledBack.policies).toEqual(head.policies);

      // Supported recovery: the re-enable script restores exactly the head catalog.
      await admin.unsafe(readFileSync(REENABLE, "utf8"));
      expect(await catalog(admin)).toEqual(head);

      // Re-applying 0012 itself also restores RLS and policies, but its blanket GRANT widens table privileges that
      // 0013/0015/0019 had narrowed. This pins that known behaviour so it cannot change unnoticed (see the docs).
      await admin.unsafe(readFileSync(ROLLBACK, "utf8"));
      await admin.unsafe(readFileSync(join(MIGRATIONS, "0012_row_level_security.sql"), "utf8").replace(/--> statement-breakpoint/g, ""));
      const reapplied = await catalog(admin);
      expect(reapplied.policies).toEqual(head.policies);
      expect(reapplied.tables.map((t) => [t.relname, t.rls, t.forced])).toEqual(head.tables.map((t) => [t.relname, t.rls, t.forced]));
      const widened = reapplied.tables.filter((t, i) => t.acl !== head.tables[i].acl).map((t) => t.relname);
      expect(widened).toEqual(expect.arrayContaining(["security_events", "usage_ledger"]));
    } finally {
      await admin.end();
    }
  });
});
