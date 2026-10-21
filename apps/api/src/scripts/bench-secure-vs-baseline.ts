/**
 * Local benchmark: BASELINE (owner connection, no tenant scope, RLS bypassed - what the pre-RLS implementation
 * effectively did) versus SECURED (restricted role `voice_app`, per-statement tenant scope, RLS enforced).
 *
 * Run from apps/api:   npx tsx src/scripts/bench-secure-vs-baseline.ts
 *   BENCH_SAMPLES=2000  BENCH_WARMUP=200  BENCH_ORGS=20  BENCH_ROWS=500  BENCH_CONCURRENCY=1,16
 *   BENCH_CASES=1,2,...  (subset of case numbers)  BENCH_JSON=<path> (also write raw summary as JSON)
 *
 * It creates the DISPOSABLE database `voice_agent_bench_test` on the server named by DATABASE_URL (read from .env, never
 * printed), applies the repository migrations, seeds synthetic tenants, runs the cases and DROPs the database.
 * It never touches the configured (development) database, makes no provider or network calls, and uses the mock
 * configuration only. Numbers are LOCAL and relative; see docs/security/performance.md for the caveats.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql as dsql } from "drizzle-orm";
import { loadEnv } from "../config/env.js";

const BENCH_DB = "voice_agent_bench_test";
const RUNTIME_ROLE = "voice_app";
const RUNTIME_PASSWORD = "voice_app_bench_password";
const POOL_MAX = 10;

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 2000);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 200);
const ORGS = Number(process.env.BENCH_ORGS ?? 20);
const ROWS = Number(process.env.BENCH_ROWS ?? 500);
const CONCURRENCIES = (process.env.BENCH_CONCURRENCY ?? "1,16").split(",").map(Number);
const ONLY_CASES = process.env.BENCH_CASES ? new Set(process.env.BENCH_CASES.split(",").map(Number)) : null;

type Mode = "baseline" | "secured";

interface OrgFixture {
  id: string;
  agentId: string;
  leadIds: string[];
  callIds: string[];
}

interface Summary {
  caseName: string;
  mode: Mode;
  concurrency: number;
  samples: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  throughput: number;
  maxAppActive: number;
  maxOwnerActive: number;
  maxAppTotal: number;
  maxOwnerTotal: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  loadEnv();
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set (needed only to locate the local server and owner credentials).");
  const ownerUrlFor = (db: string) => {
    const u = new URL(baseUrl);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const runtimeUrl = (() => {
    const u = new URL(ownerUrlFor(BENCH_DB));
    u.username = RUNTIME_ROLE;
    u.password = RUNTIME_PASSWORD;
    return u.toString();
  })();
  const ownerBenchUrl = ownerUrlFor(BENCH_DB);
  const host = new URL(baseUrl).host;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw new Error("Refusing to benchmark against a non-local server.");

  // ---- create the disposable database and apply the repository migrations -------------------------------------
  const maint = postgres(ownerUrlFor("postgres"), { max: 1 });
  await maint.unsafe(`DROP DATABASE IF EXISTS "${BENCH_DB}" WITH (FORCE)`);
  await maint.unsafe(`CREATE DATABASE "${BENCH_DB}"`);
  await maint.end();

  let appSql: postgres.Sql | undefined;
  let adminSql: postgres.Sql | null | undefined;
  const results: Summary[] = [];
  let meta: Record<string, unknown> = {};
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const setup = postgres(ownerBenchUrl, { max: 1, onnotice: () => {}, connection: { application_name: "bench-ctl" } });
    await migrate(drizzle(setup), { migrationsFolder: join(here, "../db/migrations") });
    await setup.unsafe(`ALTER ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    const [roleInfo] = await setup`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    const [appRole] = await setup`select rolsuper, rolbypassrls from pg_roles where rolname = ${RUNTIME_ROLE}`;
    const [ver] = await setup`select version() as v`;
    if (!roleInfo.rolsuper && !roleInfo.rolbypassrls) {
      throw new Error("The owner role is neither superuser nor BYPASSRLS: the baseline would still be subject to RLS. Aborting.");
    }
    meta = {
      ownerBypassesRls: true,
      runtimeSuper: appRole.rolsuper,
      runtimeBypassRls: appRole.rolbypassrls,
      postgres: String(ver.v).split(" on ")[0],
      node: process.version,
      poolMax: POOL_MAX,
      samples: SAMPLES,
      warmup: WARMUP,
      orgs: ORGS,
      rowsPerOrg: ROWS,
    };

    // ---- seed synthetic tenants through the owner connection ---------------------------------------------------
    const fixtures: OrgFixture[] = [];
    await setup.begin(async (tx) => {
      for (let o = 0; o < ORGS; o++) {
        const [org] = await tx`insert into organizations (name, slug) values (${`Bench Org ${o}`}, ${`bench-org-${o}`}) returning id`;
        const [project] = await tx`insert into projects (organization_id, name, location) values (${org.id}, 'Bench Project', 'Nowhere') returning id`;
        const [agent] = await tx`insert into agents (organization_id, name, persona_name, is_default) values (${org.id}, 'Bench Agent', 'Bench', true) returning id`;
        const leads = await tx`
          insert into leads (organization_id, project_id, name, phone)
          select ${org.id}, ${project.id}, 'Lead ' || g, '+9190' || lpad((${o} * 100000 + g)::text, 8, '0')
          from generate_series(1, ${ROWS}) g returning id`;
        const callRows = await tx`
          insert into calls (organization_id, agent_id, status, counterparty_number)
          select ${org.id}, ${agent.id}, 'completed', '+9180' || lpad((${o} * 100000 + g)::text, 8, '0')
          from generate_series(1, ${ROWS}) g returning id`;
        await tx`insert into conversations (organization_id, call_id, transcript) select ${org.id}, id, '[]'::jsonb from calls where organization_id = ${org.id}`;
        fixtures.push({ id: org.id, agentId: agent.id, leadIds: leads.map((r) => r.id as string), callIds: callRows.map((r) => r.id as string) });
      }
    });
    await setup.unsafe("ANALYZE");

    // ---- point the application client at the bench database (secured = voice_app, baseline = owner) ------------
    process.env.DATABASE_URL = runtimeUrl;
    process.env.DATABASE_ADMIN_URL = ownerBenchUrl;
    process.env.DATABASE_POOL_MAX = String(POOL_MAX);
    process.env.DATABASE_PREPARE = "true";
    const clientMod = await import("../db/client.js");
    appSql = clientMod.sql;
    adminSql = clientMod.adminSql;
    const { db } = clientMod;
    const { runInTenant, runAsAdmin } = await import("../db/tenant-context.js");
    const schema = await import("../db/schema.js");
    const { callsRepository } = await import("../db/repositories/calls.repository.js");
    const { conversationsRepository } = await import("../db/repositories/conversations.repository.js");
    const { streamTokenUsesRepository } = await import("../db/repositories/security.repository.js");
    const { issueStreamToken, verifyStreamToken } = await import("../security/stream-token.js");

    // ---- sanity: the two modes really differ the way we claim ---------------------------------------------------
    {
      const f = fixtures[0];
      const secNoScope = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.leads);
      if (secNoScope[0].n !== 0) throw new Error("Sanity check failed: unscoped runtime read returned rows (RLS not enforced).");
      const secScoped = await runInTenant({ organizationId: f.id }, async () => await db.select({ n: dsql<number>`count(*)::int` }).from(schema.leads));
      if (secScoped[0].n !== ROWS) throw new Error(`Sanity check failed: scoped read saw ${secScoped[0].n} rows, expected ${ROWS}.`);
      const base = await runAsAdmin(async () => await db.select({ n: dsql<number>`count(*)::int` }).from(schema.leads));
      if (base[0].n !== ROWS * ORGS) throw new Error("Sanity check failed: baseline did not see every tenant.");
    }

    const orgOf = (i: number) => fixtures[i % fixtures.length];

    // ---- cases ----------------------------------------------------------------------------------------------------
    // Every op receives the sample index. `exec(org, fn)` wraps it in the mode's context; the body is IDENTICAL.
    interface BenchCase {
      id: number;
      name: string;
      /** Optional per-run preparation (e.g. pre-signed tokens); not timed. */
      prepare?: (total: number) => Promise<void>;
      /** Body; `org` is the tenant the sample works for. */
      body: (org: OrgFixture, i: number) => Promise<unknown>;
      /** false = the statement is what the app runs WITHOUT a tenant scope (stream-token uses table has no tenant). */
      scoped?: boolean;
    }

    let tokens: Array<{ token: string; jti: string; expiresAt: Date; callId: string }> = [];
    const cases: BenchCase[] = [
      {
        id: 1,
        name: "indexed read (lead by org+id)",
        body: async (org, i) => {
          const id = org.leadIds[i % org.leadIds.length];
          return db.select().from(schema.leads).where(and(eq(schema.leads.organizationId, org.id), eq(schema.leads.id, id))).limit(1);
        },
      },
      {
        id: 2,
        name: "list (50 leads, newest first)",
        body: async (org) =>
          db.select().from(schema.leads).where(eq(schema.leads.organizationId, org.id)).orderBy(dsql`${schema.leads.createdAt} desc`).limit(50),
      },
      {
        id: 3,
        name: "insert audit_logs + update lead (2 statements)",
        body: async (org, i) => {
          await db.insert(schema.auditLogs).values({
            organizationId: org.id,
            actorType: "system",
            actorSource: "bench",
            action: "bench.write",
            entityType: "lead",
            metadata: { i },
          });
          const id = org.leadIds[i % org.leadIds.length];
          return db
            .update(schema.leads)
            .set({ status: i % 2 ? "ANSWERED" : "NEW" })
            .where(and(eq(schema.leads.organizationId, org.id), eq(schema.leads.id, id)))
            .returning({ id: schema.leads.id });
        },
      },
      {
        id: 4,
        name: "db.transaction (insert + update + select)",
        body: async (org, i) =>
          db.transaction(async (tx) => {
            const id = org.leadIds[i % org.leadIds.length];
            await tx.insert(schema.auditLogs).values({
              organizationId: org.id,
              actorType: "system",
              actorSource: "bench",
              action: "bench.tx",
              entityType: "lead",
              entityId: id,
              metadata: { i },
            });
            await tx
              .update(schema.leads)
              .set({ updatedAt: new Date() })
              .where(and(eq(schema.leads.organizationId, org.id), eq(schema.leads.id, id)));
            return tx.select().from(schema.leads).where(and(eq(schema.leads.organizationId, org.id), eq(schema.leads.id, id))).limit(1);
          }),
      },
      {
        id: 5,
        name: "call setup (create call + conversation + status)",
        body: async (org, i) => {
          const call = await callsRepository.create({
            organizationId: org.id,
            agentId: org.agentId,
            status: "initiating",
            callType: "outbound",
            leadId: org.leadIds[i % org.leadIds.length],
            counterpartyNumber: "+919000000000",
          });
          await conversationsRepository.createForCall({ organizationId: org.id, callId: call.id });
          return callsRepository.updateStatus({ organizationId: org.id, id: call.id, status: "in_progress", startedAt: new Date() });
        },
      },
      {
        id: 6,
        name: "stream auth (verifyStreamToken + consume)",
        scoped: false,
        prepare: async (total) => {
          tokens = [];
          for (let i = 0; i < total; i++) {
            const o = orgOf(i);
            const callId = o.callIds[i % o.callIds.length];
            const t = await issueStreamToken({ callId, organizationId: o.id, provider: "mock" });
            tokens.push({ ...t, callId });
          }
        },
        body: async (_org, i) => {
          const t = tokens[i];
          const claims = await verifyStreamToken(t.token);
          return streamTokenUsesRepository.consume({ jti: claims.jti, callId: claims.callId, expiresAt: claims.expiresAt });
        },
      },
      {
        id: 7,
        name: "tool-call persistence (conversations.appendTurn)",
        body: async (org, i) =>
          conversationsRepository.appendTurn({
            organizationId: org.id,
            callId: org.callIds[i % org.callIds.length],
            turn: { speaker: i % 2 ? "ai" : "lead", text: `bench turn ${i}`, timestamp: new Date().toISOString() },
          }),
      },
    ];

    // ---- runner -------------------------------------------------------------------------------------------------
    const monitor = postgres(ownerBenchUrl, { max: 1, onnotice: () => {}, connection: { application_name: "bench-ctl" } });
    const sampleConns = async () => {
      const rows = await monitor`
        select usename, count(*)::int as total, (count(*) filter (where state <> 'idle'))::int as active
        from pg_stat_activity
        where datname = ${BENCH_DB} and application_name <> 'bench-ctl' and backend_type = 'client backend' group by usename`;
      const out = { appTotal: 0, appActive: 0, ownerTotal: 0, ownerActive: 0 };
      for (const r of rows) {
        if (r.usename === RUNTIME_ROLE) {
          out.appTotal += r.total as number;
          out.appActive += r.active as number;
        } else {
          out.ownerTotal += r.total as number;
          out.ownerActive += r.active as number;
        }
      }
      return out;
    };

    const run = async (c: BenchCase, mode: Mode, concurrency: number): Promise<Summary> => {
      const total = WARMUP + SAMPLES;
      await setup`update conversations set transcript = '[]'::jsonb where transcript <> '[]'::jsonb`;
      await c.prepare?.(total);
      const exec = (i: number): Promise<unknown> => {
        const org = orgOf(i);
        const call = () => c.body(org, i);
        if (mode === "baseline") return runAsAdmin(async () => await call());
        if (c.scoped === false) return call();
        return runInTenant({ organizationId: org.id }, async () => await call());
      };
      const lat: number[] = [];
      let errors = 0;
      const errKinds = new Map<string, number>();
      let next = 0;
      const mx = { appTotal: 0, appActive: 0, ownerTotal: 0, ownerActive: 0 };
      let stopMon = false;
      const mon = (async () => {
        while (!stopMon) {
          const s = await sampleConns();
          mx.appTotal = Math.max(mx.appTotal, s.appTotal);
          mx.appActive = Math.max(mx.appActive, s.appActive);
          mx.ownerTotal = Math.max(mx.ownerTotal, s.ownerTotal);
          mx.ownerActive = Math.max(mx.ownerActive, s.ownerActive);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      let t0 = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= total) return;
          if (i === WARMUP && t0 === 0) t0 = performance.now();
          const start = performance.now();
          try {
            await exec(i);
            if (i >= WARMUP) lat.push(performance.now() - start);
          } catch (e) {
            if (i >= WARMUP) errors++;
            const m = e instanceof Error ? e.message.slice(0, 160) : String(e);
            errKinds.set(m, (errKinds.get(m) ?? 0) + 1);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      const elapsed = performance.now() - t0;
      stopMon = true;
      await mon;
      for (const [m, n] of errKinds) console.log(`  ! ${n}x ${m}`);
      const sorted = lat.slice().sort((a, b) => a - b);
      return {
        caseName: `${c.id}. ${c.name}`,
        mode,
        concurrency,
        samples: sorted.length,
        errors,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
        throughput: sorted.length / (elapsed / 1000),
        maxAppActive: mx.appActive,
        maxOwnerActive: mx.ownerActive,
        maxAppTotal: mx.appTotal,
        maxOwnerTotal: mx.ownerTotal,
      };
    }

    const f2 = (n: number) => n.toFixed(2);
    console.log(`bench: ${ORGS} orgs x ${ROWS} leads/calls, ${SAMPLES} samples (+${WARMUP} warmup), pool max ${POOL_MAX}`);
    console.log("case | conc | mode | n | err | p50 | p95 | p99 | mean ms | ops/s | max active conns (role) | pool footprint (role)");
    for (const c of cases) {
      if (ONLY_CASES && !ONLY_CASES.has(c.id)) continue;
      for (const conc of CONCURRENCIES) {
        // Alternate order per case so neither mode always benefits from a warmer cache.
        const order: Mode[] = c.id % 2 ? ["baseline", "secured"] : ["secured", "baseline"];
        for (const mode of order) {
          const s = await run(c, mode, conc);
          results.push(s);
          console.log(
            `${s.caseName} | ${conc} | ${mode} | ${s.samples} | ${s.errors} | ${f2(s.p50)} | ${f2(s.p95)} | ${f2(s.p99)} | ${f2(s.mean)} | ${s.throughput.toFixed(0)} | ${mode === "secured" ? s.maxAppActive : s.maxOwnerActive} | ${mode === "secured" ? s.maxAppTotal : s.maxOwnerTotal}`,
          );
        }
      }
    }
    await monitor.end();
    await setup.end();
    if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify({ meta, results }, null, 2));
    console.log("meta:", JSON.stringify(meta));
  } finally {
    try {
      await appSql?.end({ timeout: 5 });
      await adminSql?.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
    const drop = postgres(ownerUrlFor("postgres"), { max: 1 });
    await drop.unsafe(`DROP DATABASE IF EXISTS "${BENCH_DB}" WITH (FORCE)`);
    await drop.end();
    console.log(`dropped ${BENCH_DB}`);
  }
}

main().catch((err) => {
  console.error("bench failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
