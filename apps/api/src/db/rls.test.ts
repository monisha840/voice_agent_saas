/**
 * Row-level security, verified against the real PostgreSQL engine and the real restricted runtime role (voice_app):
 * the catalog is in the intended state, the runtime role cannot bypass it, tenant context is transaction-local and
 * fails closed, and raw SQL (no application filters at all) is still confined to the active organization.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as runtimeSql, adminSql, db } from "./client.js";
import { runInTenant } from "./tenant-context.js";
import { systemLookups } from "./system-lookups.js";
import { sql as dsql } from "drizzle-orm";
import { cleanupTenants, createTenant, type TestTenant } from "../test/tenants.js";

let A: TestTenant;
let B: TestTenant;

/** Raw SQL as the runtime role with an explicit (possibly absent) tenant, exactly as the client sets it. */
async function asTenant<T>(org: string | null, user: string | null, fn: (tx: typeof runtimeSql) => Promise<T>): Promise<T> {
  return runtimeSql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${org ?? ""}, true), set_config('app.user_id', ${user ?? ""}, true)`;
    return fn(tx as unknown as typeof runtimeSql);
  }) as Promise<T>;
}

beforeAll(async () => {
  A = await createTenant("RlsA");
  B = await createTenant("RlsB");
});

afterAll(async () => {
  await cleanupTenants();
});

describe("catalog: every tenant-owned table is protected", () => {
  it("has RLS enabled AND forced, with a policy, on every table that carries organization_id", async () => {
    const rows = await adminSql!`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
    `;
    expect(rows.length).toBeGreaterThanOrEqual(16);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must have RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} must have RLS forced`).toBe(true);
      expect(r.policies, `${r.relname} must have a policy`).toBeGreaterThan(0);
    }
  });

  it("also protects the tenant root (organizations) and memberships", async () => {
    const rows = await adminSql!`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('organizations', 'memberships') and relkind = 'r'`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([true, true]);
  });
});

describe("the runtime role cannot bypass or reconfigure anything", () => {
  it("is not a superuser, has no BYPASSRLS, and is not an owner of any table", async () => {
    const [me] = await runtimeSql`select current_user as u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
      from pg_roles r where r.rolname = current_user`;
    expect(me.u).toBe("voice_app");
    expect([me.rolsuper, me.rolbypassrls, me.rolcreaterole, me.rolcreatedb]).toEqual([false, false, false, false]);
    const owned = await runtimeSql`select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user`;
    expect(owned[0].n).toBe(0);
  });

  it("cannot disable RLS, drop policies, create tables, or change roles", async () => {
    await expect(runtimeSql.unsafe("alter table leads disable row level security")).rejects.toThrow();
    await expect(runtimeSql.unsafe("drop policy tenant_isolation on leads")).rejects.toThrow();
    await expect(runtimeSql.unsafe("create table evil (id int)")).rejects.toThrow();
    await expect(runtimeSql.unsafe("set role voice_agent")).rejects.toThrow();
    await expect(runtimeSql.unsafe("set session authorization voice_agent")).rejects.toThrow();
  });

  it("cannot rewrite the append-only ledgers", async () => {
    await expect(asTenant(A.orgId, null, (tx) => tx.unsafe("update audit_logs set action = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(A.orgId, null, (tx) => tx.unsafe("delete from audit_logs"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(A.orgId, null, (tx) => tx.unsafe("update usage_events set quantity = 0"))).rejects.toThrow(/permission denied/);
  });

  it("cannot create organizations (provisioning is administrative)", async () => {
    await expect(
      asTenant(A.orgId, null, (tx) => tx.unsafe("insert into organizations (name, slug) values ('x', 'x-rls-evil')")),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("fails closed without a valid tenant context", () => {
  it("returns no rows and accepts no writes with no context at all", async () => {
    const rows = await runtimeSql`select id from leads`;
    expect(rows).toHaveLength(0);
    await expect(
      runtimeSql.unsafe(`insert into projects (organization_id, name, location) values ('${A.orgId}', 'x', 'y')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("treats an empty tenant setting as no tenant", async () => {
    const rows = await asTenant(null, null, (tx) => tx`select id from leads`);
    expect(rows).toHaveLength(0);
  });

  it("rejects a malformed tenant setting instead of matching anything", async () => {
    await expect(asTenant("not-a-uuid", null, (tx) => tx`select id from leads`)).rejects.toThrow();
    expect(() => runInTenant({ organizationId: "not-a-uuid" }, () => 1)).toThrow(/Invalid organization id/);
    expect(() => runInTenant({ userId: "x" }, () => 1)).toThrow(/Invalid user id/);
  });

  it("a statement through the application client with no scope sees no tenant data", async () => {
    const rows = await db.execute(dsql`select id from leads`);
    expect((rows as unknown as unknown[]).length).toBe(0);
  });
});

describe("raw SQL is confined to the active organization (no application filter involved)", () => {
  it("A sees only A's rows in every tenant table; B only B's", async () => {
    for (const table of ["projects", "leads", "calls", "conversations", "agents", "site_visits"]) {
      const a = await asTenant(A.orgId, null, (tx) => tx.unsafe(`select organization_id from ${table}`));
      const b = await asTenant(B.orgId, null, (tx) => tx.unsafe(`select organization_id from ${table}`));
      expect(a.length, `${table} A`).toBeGreaterThan(0);
      expect(b.length, `${table} B`).toBeGreaterThan(0);
      expect(new Set(a.map((r) => r.organization_id))).toEqual(new Set([A.orgId]));
      expect(new Set(b.map((r) => r.organization_id))).toEqual(new Set([B.orgId]));
    }
  });

  it("cannot read another tenant's row even by exact primary key", async () => {
    const rows = await asTenant(A.orgId, null, (tx) => tx`select id from leads where id = ${B.leadId}`);
    expect(rows).toHaveLength(0);
  });

  it("cannot update or delete another tenant's rows (0 rows affected, data unchanged)", async () => {
    const upd = await asTenant(A.orgId, null, (tx) => tx`update leads set name = 'pwned' where id = ${B.leadId}`);
    expect(upd.count).toBe(0);
    const del = await asTenant(A.orgId, null, (tx) => tx`delete from projects where id = ${B.projectId}`);
    expect(del.count).toBe(0);
    const [still] = await adminSql!`select name from leads where id = ${B.leadId}`;
    expect(still.name).not.toBe("pwned");
    const [proj] = await adminSql!`select id from projects where id = ${B.projectId}`;
    expect(proj).toBeTruthy();
  });

  it("cannot insert a row attributed to another tenant", async () => {
    await expect(
      asTenant(A.orgId, null, (tx) =>
        tx`insert into projects (organization_id, name, location) values (${B.orgId}, 'sneaky', 'x')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot move an owned row to another tenant (WITH CHECK)", async () => {
    await expect(
      asTenant(A.orgId, null, (tx) => tx`update projects set organization_id = ${B.orgId} where id = ${A.projectId}`),
    ).rejects.toThrow(/row-level security/);
    const [p] = await adminSql!`select organization_id from projects where id = ${A.projectId}`;
    expect(p.organization_id).toBe(A.orgId);
  });

  it("still allows the legitimate same-tenant write", async () => {
    const rows = await asTenant(A.orgId, null, (tx) => tx`update leads set name = ${"Renamed by A"} where id = ${A.leadId} returning id`);
    expect(rows).toHaveLength(1);
  });
});

describe("tenant context is transaction-local (connection pooling)", () => {
  it("never leaks to the next statement on the same connection", async () => {
    // Pool of connections is reused; after a scoped transaction ends, an unscoped statement must see nothing.
    for (let i = 0; i < 20; i++) {
      const inside = await asTenant(A.orgId, null, (tx) => tx`select count(*)::int as n from leads`);
      expect(inside[0].n).toBeGreaterThan(0);
      const outside = await runtimeSql`select count(*)::int as n from leads`;
      expect(outside[0].n).toBe(0);
      const setting = await runtimeSql`select current_setting('app.organization_id', true) as v`;
      expect(setting[0].v ?? "").toBe("");
    }
  });

  it("A then B on the same connection never sees A's context", async () => {
    const one = postgresSingleConnection();
    try {
      const a = await one.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${A.orgId}, true)`;
        return tx`select distinct organization_id from leads`;
      });
      const b = await one.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${B.orgId}, true)`;
        return tx`select distinct organization_id from leads`;
      });
      const none = await one`select count(*)::int as n from leads`;
      expect(a.map((r) => r.organization_id)).toEqual([A.orgId]);
      expect(b.map((r) => r.organization_id)).toEqual([B.orgId]);
      expect(none[0].n).toBe(0);
    } finally {
      await one.end();
    }
  });

  it("is cleared by a rolled-back transaction", async () => {
    await expect(
      runtimeSql.begin(async (tx) => {
        await tx`select set_config('app.organization_id', ${A.orgId}, true)`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await runtimeSql`select count(*)::int as n from leads`;
    expect(rows[0].n).toBe(0);
  });

  it("concurrent requests for different tenants never contaminate each other", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const t = i % 2 === 0 ? A : B;
        return runInTenant({ organizationId: t.orgId }, async () => {
          const rows = (await db.execute(dsql`select organization_id from leads`)) as unknown as Array<{ organization_id: string }>;
          return { expected: t.orgId, got: new Set(rows.map((r) => r.organization_id)), n: rows.length };
        });
      }),
    );
    for (const r of results) {
      expect(r.n).toBeGreaterThan(0);
      expect(r.got).toEqual(new Set([r.expected]));
    }
  });

  it("nested scopes inherit and restore (inner org, then outer again)", async () => {
    await runInTenant({ organizationId: A.orgId }, async () => {
      const inner = await runInTenant({ organizationId: B.orgId }, async () => {
        const r = (await db.execute(dsql`select distinct organization_id from leads`)) as unknown as Array<{ organization_id: string }>;
        return r.map((x) => x.organization_id);
      });
      expect(inner).toEqual([B.orgId]);
      const outer = (await db.execute(dsql`select distinct organization_id from leads`)) as unknown as Array<{ organization_id: string }>;
      expect(outer.map((x) => x.organization_id)).toEqual([A.orgId]);
    });
  });
});

describe("memberships and organizations", () => {
  it("a user sees their own memberships across organizations but cannot write them from a user-only scope", async () => {
    const own = await asTenant(null, A.userId, (tx) => tx`select organization_id from memberships`);
    expect(own.map((r) => r.organization_id)).toEqual([A.orgId]);
    const upd = await asTenant(null, A.userId, (tx) => tx`update memberships set role = 'OWNER' where user_id = ${A.userId}`);
    expect(upd.count).toBe(0);
    await expect(
      asTenant(null, A.userId, (tx) => tx`insert into memberships (organization_id, user_id, role) values (${A.orgId}, ${B.userId}, 'OWNER')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("a user sees the organizations they belong to, and no others", async () => {
    const rows = await asTenant(null, A.userId, (tx) => tx`select id from organizations`);
    expect(rows.map((r) => r.id)).toEqual([A.orgId]);
    const active = await asTenant(B.orgId, null, (tx) => tx`select id from organizations`);
    expect(active.map((r) => r.id)).toEqual([B.orgId]);
  });

  it("another organization's membership cannot be removed or re-roled", async () => {
    const del = await asTenant(A.orgId, null, (tx) => tx`delete from memberships where organization_id = ${B.orgId}`);
    expect(del.count).toBe(0);
    const upd = await asTenant(A.orgId, null, (tx) => tx`update memberships set role = 'AGENT' where organization_id = ${B.orgId}`);
    expect(upd.count).toBe(0);
  });
});

describe("the cross-tenant lookup functions", () => {
  it("resolve only an organization id from a credential the caller holds", async () => {
    expect(await systemLookups.callOrgById(A.callId)).toBe(A.orgId);
    expect(await systemLookups.callOrgById(B.callId)).toBe(B.orgId);
    expect(await systemLookups.projectOrgById(A.projectId)).toBe(A.orgId);
    expect(await systemLookups.callOrgById("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await systemLookups.callOrgByProviderCallId("no-such-sid")).toBeNull();
    expect(await systemLookups.phoneNumberOrg("+910000000000")).toBeNull();
    expect(await systemLookups.invitationOrgByTokenHash("nope")).toBeNull();
  });

  it("are SECURITY DEFINER with a fixed search_path, owned by the narrow resolver role, not executable by PUBLIC", async () => {
    const fns = await adminSql!`
      select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
             has_function_privilege('public', p.oid, 'execute') as public_exec,
             has_function_privilege('voice_app', p.oid, 'execute') as app_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where p.proname like 'app\\_resolve\\_%' or p.proname = 'app_list_stale_calls'`;
    expect(fns.length).toBe(6);
    for (const f of fns) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.owner, f.proname).toBe("voice_resolver");
      expect(String(f.proconfig), f.proname).toContain("search_path=pg_catalog, public");
      expect(f.public_exec, f.proname).toBe(false);
      expect(f.app_exec, f.proname).toBe(true);
    }
  });

  it("the resolver role holds no write privilege anywhere and only column-level SELECT", async () => {
    const writes = await adminSql!`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'voice_resolver' and privilege_type <> 'SELECT'`;
    expect(writes).toHaveLength(0);
    const tableLevel = await adminSql!`
      select table_name from information_schema.role_table_grants where grantee = 'voice_resolver'`;
    expect(tableLevel).toHaveLength(0); // column-level grants only; no whole-table SELECT
  });
});

function postgresSingleConnection() {
  // A pool of exactly one connection to the same runtime role: proves reuse of a single physical connection.
  return runtimeSqlFactory();
}

import postgres from "postgres";
function runtimeSqlFactory() {
  return postgres(process.env.DATABASE_URL!, { max: 1 });
}
