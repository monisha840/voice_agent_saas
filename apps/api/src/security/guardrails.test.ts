/**
 * Automated security guardrails. These are tripwires, not proofs: they fail when someone adds a tenant table without
 * row-level security, a repository method that is not tenant-addressed, a service that is not tenant-scoped, a new
 * direct database import, or a route that serves an unauthenticated caller. Runtime isolation is proven separately
 * (rls.test.ts, tenant-isolation.test.ts, agent-first-isolation.test.ts, roles.test.ts).
 *
 * Every exception below names why it is safe. Do not add a blanket suppression: add one method, with its reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { buildApp } from "../app.js";
import { adminSql } from "../db/client.js";
import { isPublicPath, REGISTERED_ROUTES } from "../auth/auth.plugin.js";
import { isTenantScoped } from "../auth/tenant-scoped.js";

const SRC = join(__dirname, "..");
const files = (dir: string, pred: (f: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p, pred) : pred(p) ? [p] : [];
  });
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

// ---------------------------------------------------------------------------------------------------------------
describe("database catalog", () => {
  /** Every public table and what it is. A new table must be classified here, deliberately. */
  const CLASSIFICATION: Record<string, "tenant" | "tenant-root" | "membership" | "identity" | "security-events" | "reference"> = {
    projects: "tenant",
    project_knowledge: "tenant",
    leads: "tenant",
    calls: "tenant",
    conversations: "tenant",
    site_visits: "tenant",
    follow_ups: "tenant",
    organization_modules: "tenant",
    project_members: "tenant",
    invitations: "tenant",
    agent_configs: "tenant",
    agents: "tenant",
    agent_knowledge_bindings: "tenant",
    audit_logs: "tenant",
    usage_events: "tenant",
    agent_phone_numbers: "tenant",
    // Billing (migration 0019): tenant state + append-only ledger/event log, plus the global plan catalog.
    subscriptions: "tenant",
    usage_ledger: "tenant",
    billing_events: "tenant",
    // Knowledge base (migration 0023): organization-owned collections, documents and searchable passages.
    knowledge_bases: "tenant",
    knowledge_documents: "tenant",
    knowledge_items: "tenant",
    plans: "reference", // global configuration; no organization_id, no RLS; the runtime role holds SELECT only
    organizations: "tenant-root",
    memberships: "membership",
    security_events: "security-events",
    // Archive of purged security_events (migration 0015): organization_id nullable like its source; the runtime role
    // has no privilege on it, only voice_retention (via app_purge_security_events) can insert.
    security_events_archive: "security-events",
    // Identity data: addressed by the user, never by organization. Holds hashes/sealed values only.
    users: "identity",
    sessions: "identity",
    mfa_recovery_codes: "identity",
    auth_throttle: "identity",
    account_tokens: "identity", // single-use reset/verification tokens: user id + sha256(token) + timestamps; no tenant column, no tenant data
    stream_token_uses: "identity", // operational counters keyed by token id; no tenant data
    rate_limit_buckets: "identity", // shared rate-limit counters keyed by SHA-256; no tenant column, no tenant data
    stream_claims: "identity", // call id + instance id + heartbeat only; no tenant column, no tenant data
    stream_grants: "identity", // sha256(grant) + call id + provider call id + counters; no tenant column, no tenant data
  };

  it("classifies every table: nothing new can appear without a decision about its isolation", async () => {
    const rows = await adminSql!`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const names = rows.map((r) => r.table_name as string).sort();
    expect(names).toEqual(Object.keys(CLASSIFICATION).sort());
  });

  it("every table with an organization_id column is tenant-protected by RLS (forced) with a policy", async () => {
    const rows = await adminSql!`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)`;
    const covered = new Set(rows.map((r) => r.relname as string));
    for (const [table, cls] of Object.entries(CLASSIFICATION)) {
      if (cls === "identity" || cls === "reference") expect(covered.has(table), `${table} is not tenant data and must not carry organization_id`).toBe(false);
      else if (cls === "tenant-root") expect(covered.has(table), `${table} is the tenant root (addressed by id)`).toBe(false);
      else expect(covered.has(table), `${table} must carry organization_id`).toBe(true);
    }
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname}`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname}`).toBe(true);
      expect(r.policies, `${r.relname}`).toBeGreaterThan(0);
    }
  });

  it("every tenant-owned table's organization_id is NOT NULL (a row cannot be unowned)", async () => {
    const rows = await adminSql!`
      select table_name, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name = 'organization_id'`;
    for (const r of rows) {
      const cls = CLASSIFICATION[r.table_name as string];
      if (cls === "security-events") expect(r.is_nullable).toBe("YES"); // pre-tenant events (failed login) have no organization
      else expect(r.is_nullable, `${r.table_name}`).toBe("NO");
    }
  });

  it("no policy is permissive for PUBLIC beyond tenant matching (no USING (true))", async () => {
    const rows = await adminSql!`
      select polname, polrelid::regclass::text as tbl, pg_get_expr(polqual, polrelid) as using_expr,
             pg_get_expr(polwithcheck, polrelid) as check_expr, polroles
      from pg_policy`;
    for (const r of rows) {
      const expr = `${r.using_expr ?? ""} ${r.check_expr ?? ""}`.trim();
      if (r.polname === "resolver_lookup") continue; // voice_resolver only (column-level SELECT), see rls.test.ts
      if (String(r.polname).startsWith("retention_")) continue; // voice_retention only (no tenant context), see retention.test.ts
      expect(expr, `${r.tbl}.${r.polname}`).not.toMatch(/^\s*true\s*$/i);
      expect(expr, `${r.tbl}.${r.polname}`).toMatch(/app_current_(org|user)/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("repository query shape (AST)", () => {
  /**
   * Methods allowed to be addressed by something other than { organizationId }. Each states why that is safe.
   * Key: "<file>:<method>".
   */
  const EXCEPTIONS: Record<string, string> = {
    // identity data, addressed by the user
    "users.repository.ts:*": "identity data: addressed by user id / email; no tenant-owned columns",
    "sessions.repository.ts:*": "identity data: addressed by token hash / user id",
    "security.repository.ts:authThrottleRepository.*": "global login counters keyed by SHA-256; no tenant data",
    "security.repository.ts:rateLimitBucketsRepository.*": "shared rate-limit counters keyed by SHA-256 of scope|identifier; no tenant data",
    "security.repository.ts:streamTokenUsesRepository.*": "per-token connection counters keyed by random token id; no tenant data",
    "security.repository.ts:streamClaimsRepository.*": "cross-instance stream claims keyed by call id; hold only ids and timestamps, no tenant data",
    "security.repository.ts:streamGrantsRepository.*": "per-call stream grants keyed by SHA-256 of an opaque random grant; hold only ids and counters, no tenant data",
    "security.repository.ts:mfaRecoveryCodesRepository.*": "user-owned recovery hashes, addressed by user id",
    "security.repository.ts:securityEventsRepository.insert": "row carries organization_id (nullable by design) checked by WITH CHECK",
    "security.repository.ts:securityEventRetentionRepository.*": "retention worker: cross-tenant by design, only through the SECURITY DEFINER purge function (no row data returned)",
    "billing.repository.ts:plansRepository.*": "global plan catalog (no organization column); the runtime role has SELECT only (migration 0019)",
    // tenant root
    "organizations.repository.ts:findById": "the tenant root is addressed by its own id; RLS limits it to the active or member organizations",
    "organizations.repository.ts:findBySlug": "slug lookup for the tenant root; RLS-confined",
    "organizations.repository.ts:create": "administrative provisioning only (no INSERT policy for the runtime role)",
    "organizations.repository.ts:rename": "addressed by own id; RLS UPDATE policy limits it to the active organization",
    // self-scoped identity lookups
    "memberships.repository.ts:listForUser": "scopes itself to { userId }: RLS returns only the user's own memberships",
    // rows that carry organization_id themselves (RLS WITH CHECK enforces it equals the active organization)
    "audit.repository.ts:insert": "row carries organization_id (NOT NULL) checked by WITH CHECK",
    "usage.repository.ts:record": "row carries organization_id (NOT NULL) checked by WITH CHECK",
    // id-only methods that always run inside an organization scope (RLS-confined)
    "invitations.repository.ts:markAccepted": "addressed by invitation id; RLS confines to the active organization",
    // explicit cross-tenant lookups: must go through systemLookups / runInTenant (asserted below)
    "calls.repository.ts:findByIdAnyOrg": "SYSTEM: resolves the owner via SECURITY DEFINER lookup, then reads in that tenant",
    "calls.repository.ts:findByProviderCallIdAnyOrg": "SYSTEM: same",
    "calls.repository.ts:listStaleAnyOrg": "SYSTEM (reaper): same, grouped per organization",
    "agent-phone-numbers.repository.ts:findByNumberAnyOrg": "SYSTEM (inbound routing): same",
    "invitations.repository.ts:findUsableByTokenHashAnyOrg": "SYSTEM (accept invitation): same",
    "invitations.repository.ts:accept": "the verified invitation object carries organizationId; runs in that tenant",
    "projects.repository.ts:findActiveByIdSystem": "SYSTEM (demo endpoint): same",
  };

  function exceptionFor(file: string, obj: string, method: string): string | undefined {
    return EXCEPTIONS[`${file}:${obj}.${method}`] ?? EXCEPTIONS[`${file}:${obj}.*`] ?? EXCEPTIONS[`${file}:${method}`] ?? EXCEPTIONS[`${file}:*`];
  }

  const repoFiles = files(join(SRC, "db", "repositories"), (f) => f.endsWith(".repository.ts"));

  it("finds the repositories", () => {
    expect(repoFiles.length).toBeGreaterThanOrEqual(15);
  });

  it("every repository method is tenant-addressed ({ organizationId }) or an explicit, justified exception", () => {
    const violations: string[] = [];
    const seenExceptions = new Set<string>();
    for (const path of repoFiles) {
      const file = path.split(sep).pop()!;
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
      // Local type aliases / interfaces, so a parameter typed `NewCallParams` is checked by what that type contains.
      const localTypes = new Map<string, string>();
      sf.forEachChild((node) => {
        if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) localTypes.set(node.name.text, node.getText(sf));
      });
      const resolves = (typeText: string, depth = 0): boolean => {
        if (typeText.includes("organizationId")) return true;
        if (depth > 2) return false;
        const words = new Set(typeText.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
        for (const [name, body] of localTypes) {
          if (words.has(name) && resolves(body, depth + 1)) return true;
        }
        return false;
      };
      sf.forEachChild((node) => {
        if (!ts.isVariableStatement(node)) return;
        for (const decl of node.declarationList.declarations) {
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          const objName = decl.name.getText(sf);
          for (const member of decl.initializer.properties) {
            if (!ts.isMethodDeclaration(member) && !ts.isPropertyAssignment(member)) continue;
            const name = member.name.getText(sf);
            const fn = ts.isMethodDeclaration(member) ? member : ts.isFunctionLike(member.initializer) ? member.initializer : null;
            if (!fn || !("parameters" in fn)) continue;
            const first = (fn as ts.MethodDeclaration).parameters[0];
            const typeText = first?.type?.getText(sf) ?? "";
            if (resolves(typeText)) continue;
            const reason = exceptionFor(file, objName, name);
            if (reason) {
              seenExceptions.add(`${file}:${objName}.${name}`);
              continue;
            }
            violations.push(`${rel(path)}: ${objName}.${name}(${first?.getText(sf) ?? ""}) is not tenant-addressed and has no exception`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("every cross-tenant (AnyOrg / System) method resolves through the narrow lookups and runs in the owner's scope", () => {
    for (const path of repoFiles) {
      const text = readFileSync(path, "utf8");
      const re = /async (\w*(?:AnyOrg|System))\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const body = text.slice(m.index, m.index + 900);
        expect(body, `${rel(path)} ${m[1]}`).toMatch(/systemLookups\./);
        expect(body, `${rel(path)} ${m[1]}`).toMatch(/runInTenant\(/);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("services", () => {
  const serviceFiles = files(join(SRC, "modules"), (f) => f.endsWith(".service.ts") && !f.endsWith(".test.ts"));

  it("every exported *Service that takes a RequestContext is wrapped in tenantScoped", async () => {
    expect(serviceFiles.length).toBeGreaterThanOrEqual(12);
    for (const path of serviceFiles) {
      const mod = (await import(path)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (!/Service$/.test(name) || typeof value !== "object" || value === null) continue;
        expect(isTenantScoped(value), `${rel(path)} exports ${name} without tenantScoped()`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("direct database access", () => {
  /** Production files allowed to import the database client directly. Anything else must go through a repository. */
  const ALLOWED = [
    /^db\//, // the data-access layer itself
    /^scripts\//, // operator tooling (administrative connection)
    /^runtime\/health\.routes\.ts$/, // select 1
    /^runtime\/db-role-check\.ts$/, // startup self-check of the connected role (read-only catalog query)
    /^server\.ts$/, // pool shutdown
    /^modules\/agent-config\/agent-config\.service\.ts$/, // multi-statement transactions inside a tenant scope
    /^modules\/agents\/agents\.service\.ts$/, // transaction inside a tenant scope
    /^modules\/sales\/sales-call-hooks\.ts$/, // exists() probe inside a tenant scope
    /^modules\/auth\/account-tokens\.repository\.ts$/, // account-recovery token store (identity data, addressed by token hash / user id)
    /^test\//,
  ];

  it("no production file outside the allow-list imports the database client", () => {
    const offenders: string[] = [];
    for (const path of files(SRC, (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))) {
      const r = rel(path);
      if (r.startsWith("db/") && !r.startsWith("db/repositories/") && r !== "db/system-lookups.ts") {
        // client.ts / migrate.ts / schema.ts / tenant-context.ts are infrastructure
      }
      const text = readFileSync(path, "utf8");
      if (!/from "(?:\.\.?\/)+(?:db\/)?client\.js"/.test(text)) continue;
      if (!ALLOWED.some((re) => re.test(r))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  it("nothing outside the data layer calls the administrative connection (runAsAdmin / adminDb / adminSql)", () => {
    const offenders: string[] = [];
    for (const path of files(SRC, (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))) {
      const r = rel(path);
      if (r.startsWith("db/") || r.startsWith("scripts/") || r.startsWith("test/")) continue;
      if (/\b(runAsAdmin|adminDb|adminSql)\b/.test(readFileSync(path, "utf8"))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  it("the runtime never reaches the cross-tenant lookup functions except from the data layer", () => {
    const offenders: string[] = [];
    for (const path of files(SRC, (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))) {
      const r = rel(path);
      if (r.startsWith("db/")) continue;
      if (/\bsystemLookups\b|app_resolve_|app_list_stale/.test(readFileSync(path, "utf8"))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HTTP surface", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const concrete = (url: string) =>
    url.replace(/:[A-Za-z]+/g, "00000000-0000-0000-0000-000000000000").replace(/\*/g, "x");

  it("registers a substantial route table", () => {
    expect(REGISTERED_ROUTES.length).toBeGreaterThan(60);
  });

  it("every non-public HTTP route refuses an unauthenticated caller (401), and public ones are an explicit list", async () => {
    const publicSeen: string[] = [];
    const failures: string[] = [];
    for (const r of REGISTERED_ROUTES) {
      if (r.websocket || r.method === "HEAD" || r.method === "OPTIONS") continue;
      const url = concrete(r.url);
      if (isPublicPath(url.split("?")[0])) {
        publicSeen.push(`${r.method} ${r.url}`);
        continue;
      }
      const res = await app.inject({ method: r.method as "GET", url, payload: r.method === "GET" ? undefined : {} });
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
    // The public surface is small and known: health, readiness, the webhook-secret-protected provider endpoints, login.
    for (const p of publicSeen) {
      expect(p).toMatch(
        /\/health|\/ready|\/metrics|\/api\/telephony\/exotel\/|\/api\/auth\/(login|demo-login|config|accept-invite|forgot-password|reset-password|email-verification\/confirm)/,
      );
    }
  });

  it("websocket routes are the known media streams, and they are not reachable without credentials", async () => {
    const ws = REGISTERED_ROUTES.filter((r) => r.websocket).map((r) => r.url).sort();
    for (const u of ws) expect(u, u).toMatch(/\/api\/(telephony\/exotel\/|web-call\/)/);
  });
});
