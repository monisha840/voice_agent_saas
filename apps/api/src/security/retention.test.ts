/**
 * security_events retention, against the real PostgreSQL engine and the real restricted runtime role: the runtime
 * role still cannot delete, the SECURITY DEFINER function is the only way rows leave, and the worker is off by
 * default, bounded, concurrency-safe and survives failures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminSql, sql as runtimeSql } from "../db/client.js";
import { securityEventRetentionRepository } from "../db/repositories/security.repository.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";
import { runSecurityEventRetentionOnce, runSecurityJanitorOnce } from "../runtime/security-janitor.js";
import { logger } from "../shared/logger.js";
import { cleanupTenants, createTenant, type TestTenant } from "../test/tenants.js";

const DAY = 24 * 3600_000;
const ENV_KEYS = [
  "SECURITY_EVENT_RETENTION_ENABLED",
  "SECURITY_EVENT_RETENTION_ARCHIVE",
  "SECURITY_EVENT_RETENTION_BATCH_SIZE",
  "SECURITY_EVENT_RETENTION_MAX_BATCHES",
  "SECURITY_EVENT_RETENTION_APPROVAL_REF",
];
const NOW = new Date();
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);

let A: TestTenant;
let B: TestTenant;

async function seed(eventType: string, createdAt: Date, orgId: string | null = null): Promise<string> {
  const rows = await adminSql!`
    insert into security_events (organization_id, event_type, outcome, metadata, created_at)
    values (${orgId}, ${eventType}, 'info', ${JSON.stringify({ retention_test: "1" })}::jsonb, ${createdAt.toISOString()}::timestamptz)
    returning id`;
  return rows[0].id as string;
}

async function remaining(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await adminSql!`select id from security_events where id in ${adminSql!(ids)}`;
  return new Set(rows.map((r) => r.id as string));
}

const enable = (extra: Record<string, string> = {}) => {
  process.env.SECURITY_EVENT_RETENTION_ENABLED = "true";
  process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF = "TEST-POLICY-APPROVAL"; // deletion is gated on a recorded approval
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
};

beforeAll(async () => {
  A = await createTenant("RetA");
  B = await createTenant("RetB");
});

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
  await adminSql!`delete from security_events where metadata->>'retention_test' = '1'`;
  await adminSql!`delete from security_events where metadata->>'action' = 'security_events.retention_purge'`;
  await adminSql!`delete from security_events_archive where metadata->>'retention_test' = '1'`;
});

afterAll(async () => {
  await cleanupTenants();
});

describe("defaults and configuration", () => {
  it("is disabled by default: nothing is deleted and the function is not even called", async () => {
    const id = await seed("auth.login.failed", ago(5000));
    const spy = vi.spyOn(securityEventRetentionRepository, "purge");
    const res = await runSecurityEventRetentionOnce(NOW);
    expect(res.ran).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect((await remaining([id])).size).toBe(1);
  });

  it("uses conservative per-category defaults", async () => {
    const { getConfig } = await import("../config/env.js");
    const c = getConfig().securityRetention;
    expect(c.enabled).toBe(false);
    expect(c.archive).toBe(false);
    expect(c.daysByCategory).toEqual({ auth_session: 400, mfa_config: 730, access_denied: 400, privileged_action: 730, other: 400 });
  });
});

describe("cutoffs", () => {
  it("boundary: a row exactly AT the cutoff is kept; one millisecond older is removed", async () => {
    const cutoff = ago(10);
    const atCutoff = await seed("auth.login.failed", cutoff);
    const older = await seed("auth.login.failed", new Date(cutoff.getTime() - 1));
    const counts = await securityEventRetentionRepository.purge({
      cutoffs: { auth_session: cutoff }, batch: 100, archive: false,
    });
    expect(counts).toEqual({ auth_session: 1 });
    const left = await remaining([atCutoff, older]);
    expect(left.has(atCutoff)).toBe(true);
    expect(left.has(older)).toBe(false);
  });

  it("a category with no cutoff is never purged (fail safe)", async () => {
    const id = await seed("auth.mfa.enrolled", ago(5000));
    const counts = await securityEventRetentionRepository.purge({ cutoffs: { auth_session: ago(1) }, batch: 100, archive: false });
    expect(counts).toEqual({});
    expect((await remaining([id])).size).toBe(1);
  });

  it("applies each category's own period and leaves other categories alone", async () => {
    const cases: Array<[string, number, boolean]> = [
      // [event type, age in days, expected removed]
      ["auth.login.failed", 401, true],
      ["auth.login.failed", 399, false],
      ["session.created", 401, true],
      ["auth.mfa.enrolled", 500, false], // mfa/security configuration keeps 730
      ["auth.mfa.enrolled", 731, true],
      ["membership.role_changed", 731, true],
      ["membership.role_changed", 700, false],
      ["access.tenant_denied", 401, true],
      ["access.stream_denied", 399, false],
      ["system.privileged_action", 500, false],
      ["system.privileged_action", 731, true],
      ["something.unknown", 401, true],
      ["something.unknown", 100, false],
    ];
    const ids: string[] = [];
    for (const [type, age] of cases) ids.push(await seed(type, ago(age, 60_000)));
    enable();
    const res = await runSecurityEventRetentionOnce(NOW);
    expect(res.ran).toBe(true);
    expect(res.error).toBeUndefined();
    const left = await remaining(ids);
    cases.forEach(([type, age, removed], i) => {
      expect(left.has(ids[i]), `${type} @ ${age}d`).toBe(!removed);
    });
    const removedCount = cases.filter((c) => c[2]).length;
    expect(res.total).toBe(removedCount);
    expect(res.purged.auth_session).toBe(2);
    expect(res.purged.mfa_config).toBe(2);
    expect(res.purged.access_denied).toBe(1);
    expect(res.purged.privileged_action).toBe(1);
    expect(res.purged.other).toBe(1);
  });

  it("does not touch recent rows of any tenant; old rows of every tenant are treated alike", async () => {
    const recentA = await seed("auth.login.failed", ago(1), A.orgId);
    const recentB = await seed("access.tenant_denied", ago(2), B.orgId);
    const oldA = await seed("auth.login.failed", ago(500), A.orgId);
    const oldB = await seed("auth.login.failed", ago(500), B.orgId);
    enable();
    await runSecurityEventRetentionOnce(NOW);
    const left = await remaining([recentA, recentB, oldA, oldB]);
    expect([...left].sort()).toEqual([recentA, recentB].sort());
  });
});

describe("batching and concurrency", () => {
  it("removes at most batch x maxBatches rows per run; the next run continues", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await seed("auth.login.failed", ago(500, i)));
    enable({ SECURITY_EVENT_RETENTION_BATCH_SIZE: "10", SECURITY_EVENT_RETENTION_MAX_BATCHES: "2" });
    const first = await runSecurityEventRetentionOnce(NOW);
    expect(first.total).toBe(20);
    expect(first.batches).toBe(2);
    expect((await remaining(ids)).size).toBe(5);
    const second = await runSecurityEventRetentionOnce(NOW);
    expect(second.total).toBe(5);
    expect(second.batches).toBe(1);
    expect((await remaining(ids)).size).toBe(0);
    const third = await runSecurityEventRetentionOnce(NOW); // idempotent
    expect(third.total).toBe(0);
  });

  it("a single call never exceeds p_batch and rejects an invalid batch size", async () => {
    for (let i = 0; i < 12; i++) await seed("auth.login.failed", ago(500, i));
    const counts = await securityEventRetentionRepository.purge({ cutoffs: { auth_session: ago(400) }, batch: 5, archive: false });
    expect(counts.auth_session).toBe(5);
    await expect(
      securityEventRetentionRepository.purge({ cutoffs: { auth_session: ago(400) }, batch: 0, archive: false }),
    ).rejects.toThrow();
  });

  it("concurrent runs neither double count nor deadlock", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 90; i++) ids.push(await seed(i % 2 ? "auth.login.failed" : "session.created", ago(500, i)));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        securityEventRetentionRepository.purge({ cutoffs: { auth_session: ago(400) }, batch: 20, archive: true }),
      ),
    );
    const purgedNow = results.reduce((s, r) => s + (r.auth_session ?? 0), 0);
    const left = (await remaining(ids)).size;
    expect(purgedNow + left).toBe(90); // every removed row was counted exactly once
    expect(purgedNow).toBeGreaterThan(0);
    const archived = await adminSql!`select count(*)::int as n from security_events_archive where metadata->>'retention_test' = '1'`;
    expect(archived[0].n).toBe(purgedNow); // and archived exactly once

    // Parallel full runs drain the rest.
    enable({ SECURITY_EVENT_RETENTION_BATCH_SIZE: "15" });
    const runs = await Promise.all([runSecurityEventRetentionOnce(NOW), runSecurityEventRetentionOnce(NOW), runSecurityEventRetentionOnce(NOW)]);
    expect(runs.every((r) => !r.error)).toBe(true);
    expect(runs.reduce((s, r) => s + r.total, 0) + purgedNow).toBeLessThanOrEqual(90);
    await runSecurityEventRetentionOnce(NOW);
    expect((await remaining(ids)).size).toBe(0);
  });
});

describe("archive and audit trail of the purge", () => {
  it("copies rows to the archive with their original fields when archive is on", async () => {
    const id = await seed("auth.login.failed", ago(500), A.orgId);
    enable({ SECURITY_EVENT_RETENTION_ARCHIVE: "true" });
    await runSecurityEventRetentionOnce(NOW);
    expect((await remaining([id])).size).toBe(0);
    const rows = await adminSql!`select organization_id, event_type, archived_at from security_events_archive where id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(A.orgId);
    expect(rows[0].event_type).toBe("auth.login.failed");
    expect(rows[0].archived_at).toBeTruthy();
  });

  it("records a system.privileged_action event with counts only, and none when nothing was purged", async () => {
    enable();
    await runSecurityEventRetentionOnce(NOW);
    const none = await adminSql!`select count(*)::int as n from security_events where metadata->>'action' = 'security_events.retention_purge'`;
    expect(none[0].n).toBe(0);

    await seed("auth.login.failed", ago(500));
    await seed("session.created", ago(500));
    const infoSpy = vi.spyOn(logger, "info");
    await runSecurityEventRetentionOnce(NOW);
    const rows = await adminSql!`select event_type, outcome, metadata from security_events where metadata->>'action' = 'security_events.retention_purge'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("system.privileged_action");
    expect(rows[0].metadata.total).toBe(2);
    expect(rows[0].metadata.byCategory).toEqual({ auth_session: 2 });
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("retention_test");
  });
});

describe("privileges", () => {
  it("the runtime role still cannot delete, update or truncate security_events, nor touch the archive", async () => {
    const id = await seed("auth.login.failed", ago(500));
    await expect(runtimeSql.unsafe(`delete from security_events where id = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(runtimeSql.unsafe(`update security_events set outcome = 'x' where id = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(runtimeSql.unsafe("truncate security_events")).rejects.toThrow(/permission denied/);
    await expect(runtimeSql.unsafe("select * from security_events_archive")).rejects.toThrow(/permission denied/);
    await expect(runtimeSql.unsafe("insert into security_events_archive (id, event_type, outcome, created_at) values (gen_random_uuid(), 'x', 'info', now())")).rejects.toThrow(/permission denied/);
    await expect(runtimeSql.unsafe("set role voice_retention")).rejects.toThrow();
    expect((await remaining([id])).size).toBe(1);
  });

  it("the function is owned by voice_retention, SECURITY DEFINER, with a fixed search_path, executable by voice_app only", async () => {
    const [fn] = await adminSql!`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig,
             has_function_privilege('voice_app', p.oid, 'EXECUTE') as app_exec,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
      from pg_proc p where p.proname = 'app_purge_security_events'`;
    expect(fn.owner).toBe("voice_retention");
    expect(fn.prosecdef).toBe(true);
    expect(String(fn.proconfig)).toMatch(/search_path=pg_catalog, public/);
    expect(fn.app_exec).toBe(true);
    expect(fn.public_exec).toBe(false);
    const [role] = await adminSql!`select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'voice_retention'`;
    expect([role.rolcanlogin, role.rolsuper, role.rolbypassrls]).toEqual([false, false, false]);
    const tables = await adminSql!`
      select table_name from information_schema.role_table_grants
      where grantee = 'voice_retention' and table_schema = 'public' group by table_name order by 1`;
    expect(tables.map((t) => t.table_name)).toEqual(["security_events", "security_events_archive"]);
  });
});

describe("failure path", () => {
  it("logs a failing purge, never throws, and the janitor's other cleanup still runs", async () => {
    enable();
    vi.spyOn(securityEventRetentionRepository, "purge").mockRejectedValue(new Error("boom: function missing"));
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const sessions = vi.spyOn(sessionsRepository, "deleteExpired");
    await expect(runSecurityJanitorOnce(NOW)).resolves.toBeUndefined();
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("security-janitor: security event retention failed", expect.objectContaining({ error: "boom: function missing" }));
  });

  it("a failing cleanup step does not starve retention", async () => {
    await seed("auth.login.failed", ago(500));
    enable();
    vi.spyOn(sessionsRepository, "deleteExpired").mockRejectedValue(new Error("db hiccup"));
    await expect(runSecurityJanitorOnce(NOW)).rejects.toThrow("db hiccup");
    const left = await adminSql!`select count(*)::int as n from security_events where metadata->>'retention_test' = '1'`;
    expect(left[0].n).toBe(0);
  });
});

describe("approval gate", () => {
  it("the switch alone does not enable deletion: without an approval reference the worker does nothing", async () => {
    process.env.SECURITY_EVENT_RETENTION_ENABLED = "true";
    delete process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF;
    const id = await seed("auth.login.success", ago(5000));
    const result = await runSecurityEventRetentionOnce(NOW);
    expect(result.total).toBe(0);
    expect((await remaining([id])).has(id)).toBe(true);
    await adminSql!`delete from security_events where id = ${id}`;
  });
});
