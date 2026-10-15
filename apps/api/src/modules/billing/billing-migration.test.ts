/**
 * Migrations 0019/0020/0022 against disposable PostgreSQL databases: upgrade from the supported baseline (0018) with
 * data already in it, upgrade from 0021 (the dev database's position) to 0022, grants/RLS/trigger state of the billing
 * tables, and the documented rollbacks.
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

const here = fileURLToPath(new URL("../../db/", import.meta.url));
const MIGRATIONS = join(here, "migrations");
const DOWN = join(here, "rollback", "0019_0020_billing.down.sql");
const DB = "voice_agent_billing_mig_test";

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

function partialMigrations(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "va-bmig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  journal.entries = journal.entries.slice(0, cut + 1);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function fresh() {
  const maint = postgres(urlFor("postgres"), { max: 1 });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.unsafe(`CREATE DATABASE "${DB}"`);
  await maint.end();
}

afterAll(async () => {
  const maint = postgres(urlFor("postgres"), { max: 1 });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.end();
});

describe("billing migrations", () => {
  let admin: postgres.Sql;
  let orgId = "";
  beforeAll(async () => {
    await fresh();
    admin = postgres(urlFor(DB), { max: 1 });
    const baseline = partialMigrations("0018_rate_limit_buckets");
    await migrate(drizzle(admin), { migrationsFolder: baseline });
    rmSync(baseline, { recursive: true, force: true });
    await admin.unsafe(`ALTER ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    const [org] = await admin`insert into organizations (name, slug) values ('Pre-billing Co', 'pre-billing-co') returning id`;
    orgId = org.id as string;
    const [u] = await admin`insert into users (email, name, password_hash) values ('pb@example.test', 'PB', 'x') returning id`;
    await admin`insert into memberships (organization_id, user_id, role) values (${orgId}, ${u.id}, 'OWNER')`;
    await admin`insert into agents (organization_id, name, persona_name, prompt_template_key) values (${orgId}, 'A1', 'P', 'generic')`;
  });
  afterAll(async () => {
    await admin.end();
  });

  it("upgrades from 0018 with data in place; the existing organization stays unmanaged", async () => {
    await migrate(drizzle(admin), { migrationsFolder: MIGRATIONS });
    expect((await admin`select count(*)::int n from organizations`)[0].n).toBe(1);
    expect((await admin`select count(*)::int n from agents`)[0].n).toBe(1);
    expect((await admin`select count(*)::int n from subscriptions`)[0].n).toBe(0);
    const plans = await admin`select key from plans order by sort_order`;
    expect(plans.map((p) => p.key)).toEqual(["trial", "starter", "growth", "business", "enterprise"]);
    const tracked = await admin`select count(*)::int n from drizzle.__drizzle_migrations`;
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    expect(tracked[0].n).toBe(journal.entries.length);
  });

  it("every tenant-owned billing table has forced RLS with one policy; plans has none and is read-only", async () => {
    const rows = await admin`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) policies
      from pg_class c where c.relname in ('subscriptions','usage_ledger','billing_events','plans') and c.relkind = 'r'`;
    for (const t of ["subscriptions", "usage_ledger", "billing_events"]) {
      expect(rows.find((r) => r.relname === t), t).toMatchObject({ rls: true, forced: true, policies: 1 });
    }
    expect(rows.find((r) => r.relname === "plans")).toMatchObject({ rls: false });
    const priv = async (t: string, p: string) =>
      (await admin`select has_table_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${p}) as ok`)[0].ok as boolean;
    expect(await priv("plans", "SELECT")).toBe(true);
    expect(await priv("plans", "INSERT")).toBe(false);
    expect(await priv("plans", "UPDATE")).toBe(false);
    expect(await priv("usage_ledger", "DELETE")).toBe(false);
    // 0022: table-level UPDATE removed; only usage_ledger.state stays updatable (supersede), billing_events is insert-only
    expect(await priv("usage_ledger", "UPDATE")).toBe(false);
    expect(await priv("billing_events", "UPDATE")).toBe(false);
    const col = async (t: string, c: string) =>
      (await admin`select has_column_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${c}, 'UPDATE') as ok`)[0].ok as boolean;
    expect(await col("usage_ledger", "state")).toBe(true);
    expect(await col("usage_ledger", "billable_seconds")).toBe(false);
    expect(await priv("subscriptions", "UPDATE")).toBe(true);
  });

  it("seat caps apply only to managed organizations and hold under concurrent inserts", async () => {
    for (let i = 0; i < 4; i++) {
      await admin`insert into agents (organization_id, name, persona_name, prompt_template_key) values (${orgId}, ${"U" + i}, 'P', 'generic')`;
    }
    await admin`insert into subscriptions (organization_id, plan_key, status, current_period_start, current_period_end, limit_overrides)
                values (${orgId}, 'starter', 'active', now() - interval '1 day', now() + interval '29 days', '{"maxAgents":6}')`;
    // 5 active agents, cap 6: exactly one of 5 concurrent inserts may succeed.
    const writer = postgres(urlFor(DB), { max: 8 });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          writer`insert into agents (organization_id, name, persona_name, prompt_template_key) values (${orgId}, ${"C" + i}, 'P', 'generic')`,
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
        expect((r.reason as { code?: string }).code).toBe("VA010");
      }
      expect((await admin`select count(*)::int n from agents where status = 'active'`)[0].n).toBe(6);
    } finally {
      await writer.end();
    }
  });

  it("0022 as the runtime role: only ledger.state is updatable, billing_events is insert-only; its rollback and re-run behave", async () => {
    const [row] = await admin`insert into usage_ledger (organization_id, idempotency_key, source, state, rounding_policy, billable_reason, outcome, occurred_at)
                              values (${orgId}, 'call:mig-0022', 'mock', 'final', 'ceil_60s_per_call', 'billed', 'completed', now()) returning id`;
    const [ev] = await admin`insert into billing_events (organization_id, provider, provider_event_id, event_type, outcome, payload_digest)
                             values (${orgId}, 'mock', 'evt-mig-0022', 'payment_failed', 'ignored', 'x') returning id`;
    const u = new URL(urlFor(DB));
    u.username = TEST_RUNTIME_ROLE;
    u.password = TEST_RUNTIME_PASSWORD;
    const app = postgres(u.toString(), { max: 1 });
    const scoped = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${orgId}, true)`;
        return fn(tx);
      });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
    try {
      expect(await code(scoped((tx) => tx`update usage_ledger set billable_seconds = 0 where id = ${row.id}`))).toBe("42501");
      expect(await code(scoped((tx) => tx`update billing_events set outcome = 'applied' where id = ${ev.id}`))).toBe("42501");
      expect(await code(scoped((tx) => tx`delete from usage_ledger where id = ${row.id}`))).toBe("42501");
      // the one update the application performs (usageLedgerRepository.supersede)
      const done = await scoped((tx) => tx`update usage_ledger set state = 'superseded' where id = ${row.id} and state <> 'superseded' returning id`);
      expect(done).toHaveLength(1);

      // documented rollback restores table-level UPDATE (the guard trigger still blocks other columns) ...
      await admin.unsafe(readFileSync(join(here, "rollback", "0022_billing_grants_hardening.down.sql"), "utf8"));
      const err = await scoped((tx) => tx`update billing_events set outcome = 'applied' where id = ${ev.id}`).then(
        () => null,
        (e: { code?: string }) => e.code,
      );
      expect(err).toBeNull();
      // ... leaving no column-level grant behind (exactly the pre-0022 ACL) ...
      expect((await admin`select attacl from pg_attribute where attrelid = 'usage_ledger'::regclass and attname = 'state'`)[0].attacl).toBeNull();
      // ... and the migration's SQL is idempotent when re-run
      for (let i = 0; i < 2; i++) {
        await admin.unsafe(readFileSync(join(MIGRATIONS, "0022_billing_grants_hardening.sql"), "utf8").replace(/--> statement-breakpoint/g, ""));
      }
      expect(await code(scoped((tx) => tx`update billing_events set outcome = 'ignored' where id = ${ev.id}`))).toBe("42501");
    } finally {
      await app.end();
    }
  });

  it("the documented rollback removes billing objects, keeps all other data, and migrations re-apply", async () => {
    await admin.unsafe(readFileSync(DOWN, "utf8"));
    const left = await admin`select to_regclass('public.plans') p, to_regclass('public.usage_ledger') l, to_regproc('billing_cap_for') f`;
    expect(left[0].p).toBeNull();
    expect(left[0].l).toBeNull();
    expect((await admin`select count(*)::int n from agents`)[0].n).toBe(6);
    expect((await admin`select count(*)::int n from organizations`)[0].n).toBe(1);
    // Forget every migration from 0019 onwards (other agents may have added newer ones), then re-apply them all.
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
    const from = journal.entries.find((e) => e.tag === "0019_billing_foundation")!.when;
    await admin`delete from drizzle.__drizzle_migrations where created_at >= ${from}`;
    await admin.unsafe("drop table if exists stream_grants"); // a later, unrelated migration is re-applied too
    // Re-apply the billing migrations and everything up to 0022 only; later migrations (0023+) are unrelated to billing.
    const upTo0022 = partialMigrations("0022_billing_grants_hardening");
    await migrate(drizzle(admin), { migrationsFolder: upTo0022 });
    rmSync(upTo0022, { recursive: true, force: true });
    expect((await admin`select count(*)::int n from plans`)[0].n).toBe(5);
  });
});

// The development database (and any environment upgraded alongside it) sits at 0021: this is its exact upgrade path.
describe("upgrade from 0021 with billing data applies only 0022 and leaves the data untouched", () => {
  const DB21 = "voice_agent_billing_mig0021_test";
  let admin: postgres.Sql;
  beforeAll(async () => {
    const maint = postgres(urlFor("postgres"), { max: 1 });
    await maint.unsafe(`DROP DATABASE IF EXISTS "${DB21}" WITH (FORCE)`);
    await maint.unsafe(`CREATE DATABASE "${DB21}"`);
    await maint.end();
    admin = postgres(urlFor(DB21), { max: 1 });
  });
  afterAll(async () => {
    await admin.end();
    const maint = postgres(urlFor("postgres"), { max: 1 });
    await maint.unsafe(`DROP DATABASE IF EXISTS "${DB21}" WITH (FORCE)`);
    await maint.end();
  });

  it("0021 -> 0022: one new migration row, identical billing rows, narrowed grants", { timeout: 60_000 }, async () => {
    const baseline = partialMigrations("0021_stream_grants");
    await migrate(drizzle(admin), { migrationsFolder: baseline });
    rmSync(baseline, { recursive: true, force: true });
    const before = (await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n as number;
    // pre-0022 state: table-level UPDATE from default privileges
    expect((await admin`select has_table_privilege(${TEST_RUNTIME_ROLE}, 'billing_events', 'UPDATE') ok`)[0].ok).toBe(true);

    const [org] = await admin`insert into organizations (name, slug) values ('At 0021 Co', 'at-0021-co') returning id`;
    await admin`insert into subscriptions (organization_id, plan_key, status, current_period_start, current_period_end)
                values (${org.id}, 'starter', 'active', now() - interval '1 day', now() + interval '29 days')`;
    await admin`insert into usage_ledger (organization_id, idempotency_key, source, state, rounding_policy, billable_reason, outcome, occurred_at)
                values (${org.id}, 'call:at-0021', 'mock', 'final', 'ceil_60s_per_call', 'billed', 'completed', now())`;
    await admin`insert into billing_events (organization_id, provider, provider_event_id, event_type, outcome, payload_digest)
                values (${org.id}, 'mock', 'evt-at-0021', 'payment_failed', 'ignored', 'x')`;
    const digest = async () =>
      (await admin`select md5(string_agg(t, '|' order by t)) d from (
         select 's:' || row_to_json(s)::text t from subscriptions s
         union all select 'l:' || row_to_json(l)::text from usage_ledger l
         union all select 'e:' || row_to_json(e)::text from billing_events e) x`)[0].d as string;
    const dataBefore = await digest();

    // Exactly the 0021 -> 0022 step (later migrations, e.g. 0023 knowledge base, are covered by their own tests).
    const to0022 = partialMigrations("0022_billing_grants_hardening");
    await migrate(drizzle(admin), { migrationsFolder: to0022 });
    rmSync(to0022, { recursive: true, force: true });

    expect((await admin`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n).toBe(before + 1);
    expect(await digest()).toBe(dataBefore);
    const priv = async (t: string, p: string) =>
      (await admin`select has_table_privilege(${TEST_RUNTIME_ROLE}, ${t}, ${p}) ok`)[0].ok as boolean;
    expect(await priv("billing_events", "UPDATE")).toBe(false);
    expect(await priv("usage_ledger", "UPDATE")).toBe(false);
    expect(await priv("billing_events", "INSERT")).toBe(true);
    expect((await admin`select has_column_privilege(${TEST_RUNTIME_ROLE}, 'usage_ledger', 'state', 'UPDATE') ok`)[0].ok).toBe(true);
  });
});
