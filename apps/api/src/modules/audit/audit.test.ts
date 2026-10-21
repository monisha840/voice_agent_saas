/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read untyped JSON responses */
/** Audit-log read API, metadata sanitization, and append-only repository. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs } from "../../db/schema.js";
import { userContext } from "../../auth/context.js";
import { auditService, sanitizeMetadata } from "./audit.service.js";
import { auditRepository } from "../../test/repos.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
const cookies: Record<string, string> = {};

async function get(cookie: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const agent = await createMember(A.orgId, "AGENT");
  const ctxA = userContext(A.orgId, A.userId, "OWNER");
  const ctxB = userContext(B.orgId, B.userId, "OWNER");
  for (let i = 0; i < 5; i++) {
    await auditService.record(ctxA, {
      action: i % 2 ? "lead.updated" : "project.created",
      entityType: i % 2 ? "lead" : "project",
      entityId: i % 2 ? A.leadId : A.projectId,
      metadata: { n: i, password: "hunter2" },
    });
    // Distinct timestamps so cursor pagination is deterministic.
    await new Promise((r) => setTimeout(r, 5));
  }
  await auditService.record(ctxB, { action: "project.created", entityType: "project", entityId: B.projectId, metadata: { name: "B-only" } });

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies.owner = await loginCookie(baseUrl, A.email);
  cookies.admin = await loginCookie(baseUrl, admin.email);
  cookies.manager = await loginCookie(baseUrl, manager.email);
  cookies.agent = await loginCookie(baseUrl, agent.email);
  cookies.ownerB = await loginCookie(baseUrl, B.email);
});

afterAll(async () => {
  await app.close();
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, A.orgId));
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, B.orgId));
  await cleanupTenants();
});

describe("GET /api/audit-logs", () => {
  it("returns only the caller's organization, newest first, with sanitized metadata", async () => {
    const res = await get(cookies.owner, "/api/audit-logs");
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ organizationId: string; metadata: Record<string, unknown>; createdAt: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((r) => r.organizationId === A.orgId)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("B-only");
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    const times = rows.map((r) => Date.parse(r.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(res.body.nextBefore).toBeNull();

    const b = await get(cookies.ownerB, "/api/audit-logs");
    expect((b.body.data as Array<{ organizationId: string }>).every((r) => r.organizationId === B.orgId)).toBe(true);
  });

  it("paginates with limit and the before cursor without overlap", async () => {
    const page1 = await get(cookies.owner, "/api/audit-logs?limit=2");
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await get(cookies.owner, `/api/audit-logs?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`);
    const ids1 = page1.body.data.map((r: { id: string }) => r.id);
    expect(page2.body.data.length).toBeGreaterThan(0);
    expect(page2.body.data.some((r: { id: string }) => ids1.includes(r.id))).toBe(false);
    expect(Date.parse(page2.body.data[0].createdAt)).toBeLessThan(Date.parse(page1.body.data[1].createdAt) + 1);
  });

  it("filters by action, entityType and entityId", async () => {
    const byAction = await get(cookies.owner, "/api/audit-logs?action=lead.updated");
    expect(byAction.body.data).toHaveLength(2);
    const byType = await get(cookies.owner, "/api/audit-logs?entityType=project");
    expect(byType.body.data.every((r: { entityType: string }) => r.entityType === "project")).toBe(true);
    const byEntity = await get(cookies.owner, `/api/audit-logs?entityId=${A.leadId}`);
    expect(byEntity.body.data).toHaveLength(2);
    // B's entity id never leaks across organizations.
    expect((await get(cookies.owner, `/api/audit-logs?entityId=${B.projectId}`)).body.data).toHaveLength(0);
  });

  it("validates query parameters (400)", async () => {
    for (const q of ["limit=0", "limit=201", "limit=abc", "before=not-a-date", "entityId=nope"]) {
      expect((await get(cookies.owner, `/api/audit-logs?${q}`)).status, q).toBe(400);
    }
    expect((await get(cookies.owner, "/api/audit-logs?limit=200")).status).toBe(200);
  });

  it("OWNER and ADMIN may read; MANAGER, AGENT and anonymous may not", async () => {
    expect((await get(cookies.admin, "/api/audit-logs")).status).toBe(200);
    expect((await get(cookies.manager, "/api/audit-logs")).status).toBe(403);
    expect((await get(cookies.agent, "/api/audit-logs")).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/audit-logs`)).status).toBe(401);
  });
});

describe("sanitizeMetadata", () => {
  it("strips secret-style keys at any depth", () => {
    const out = sanitizeMetadata({
      password: "a",
      newPassword: "a",
      accessToken: "a",
      client_secret: "a",
      passwordHash: "a",
      Authorization: "Bearer x",
      Cookie: "va_session=x",
      "x-api-key": "a",
      apiKey: "a",
      keep: "visible",
      nested: { deep: { token: "a", inner: { secret: "a", ok: 1 } } },
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/"a"|Bearer x|va_session/);
    expect(out.keep).toBe("visible");
    expect((out.nested as any).deep.inner.ok).toBe(1);
    expect(text.match(/\[redacted\]/g)?.length).toBe(11);
  });

  it("truncates long strings, long arrays and deep nesting", () => {
    const out = sanitizeMetadata({ s: "x".repeat(2000), arr: Array.from({ length: 80 }, (_, i) => i), a: { b: { c: { d: { e: 1 } } } } }) as any;
    expect(out.s.length).toBeLessThanOrEqual(501);
    expect(out.arr).toHaveLength(50);
    expect(JSON.stringify(out.a)).toContain("[truncated]");
  });
});

describe("audit repository is append-only", () => {
  it("exposes no update or delete", () => {
    const names = Object.keys(auditRepository);
    expect(names.sort()).toEqual(["insert", "list"]);
    expect(names.some((n) => /update|delete|remove|destroy/i.test(n))).toBe(false);
  });
});
