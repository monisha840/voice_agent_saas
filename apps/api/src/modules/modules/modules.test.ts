import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { auditLogs, leads } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { modulesService } from "./modules.service.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant; // sales on
let B: TestTenant; // sales off
let cookieA: string;
let cookieB: string;
let adminCookieA: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = { data?: any; error?: string };

async function http(cookie: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

beforeAll(async () => {
  A = await createTenant("MA");
  B = await createTenant("MB", { modules: [] });
  const admin = await createMember(A.orgId, "ADMIN");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
  adminCookieA = await loginCookie(baseUrl, admin.email);
});

afterAll(async () => {
  await app.close();
  for (const t of [A, B]) await db.delete(auditLogs).where(eq(auditLogs.organizationId, t.orgId));
  await cleanupTenants();
});

describe("module state in the API", () => {
  it("/auth/me lists the active organization's enabled modules", async () => {
    expect((await http(cookieA, "/api/auth/me")).body.data.organization.modules).toEqual(["sales"]);
    expect((await http(cookieB, "/api/auth/me")).body.data.organization.modules).toEqual([]);
  });

  it("GET /organization/modules shows the catalogue with this organization's state", async () => {
    const a = await http(cookieA, "/api/organization/modules");
    expect(a.body.data).toEqual([expect.objectContaining({ key: "sales", enabled: true })]);
    const b = await http(cookieB, "/api/organization/modules");
    expect(b.body.data).toEqual([expect.objectContaining({ key: "sales", enabled: false })]);
  });
});

describe("enforcement", () => {
  it("returns 403 on every sales route when the module is off, and 200 when on", async () => {
    for (const path of ["/api/leads", "/api/projects", "/api/site-visits", `/api/leads/${B.leadId}`, `/api/projects/${B.projectId}`]) {
      const off = await http(cookieB, path);
      expect(off.status, path).toBe(403);
      expect(off.body.error).toMatch(/Sales module is not enabled/);
    }
    for (const path of ["/api/leads", "/api/projects", "/api/site-visits"]) {
      expect((await http(cookieA, path)).status, path).toBe(200);
    }
    expect((await http(cookieB, `/api/leads/${B.leadId}/call`, { method: "POST" })).status).toBe(403);
  });

  it("leaves core routes working without the module", async () => {
    expect((await http(cookieB, "/api/organization")).status).toBe(200);
    expect((await http(cookieB, "/api/usage/summary")).status).toBe(200);
    expect((await http(cookieB, "/api/agent-config")).status).toBe(200);
    expect((await http(cookieB, `/api/calls/${B.callId}`)).status).toBe(200);
  });

  it("lets system flows through (calls in progress, AI tools, post-call processing)", async () => {
    await expect(modulesService.assertEnabled(systemContext(B.orgId, "media-stream"), "sales")).resolves.toBeUndefined();
    await expect(modulesService.assertEnabled(systemContext(B.orgId, "ai-tool"), "sales")).resolves.toBeUndefined();
  });
});

describe("toggling", () => {
  it("only an OWNER can toggle; other roles and unknown keys are refused", async () => {
    expect((await http(adminCookieA, "/api/organization/modules/sales", { method: "PUT", body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    expect((await http(cookieA, "/api/organization/modules/bogus", { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(404);
    expect((await http(cookieA, "/api/organization/modules/sales", { method: "PUT", body: JSON.stringify({ enabled: "yes" }) })).status).toBe(400);
  });

  it("disabling blocks the module, keeps its data, audits the change, and re-enabling restores it", async () => {
    const off = await http(cookieA, "/api/organization/modules/sales", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ key: "sales", enabled: false });
    expect((await http(cookieA, "/api/leads")).status).toBe(403);
    expect((await http(cookieA, "/api/auth/me")).body.data.organization.modules).toEqual([]);

    // Nothing was deleted.
    expect(await db.select().from(leads).where(eq(leads.id, A.leadId))).toHaveLength(1);

    // A no-op toggle is not audited again.
    await http(cookieA, "/api/organization/modules/sales", { method: "PUT", body: JSON.stringify({ enabled: false }) });

    const on = await http(cookieA, "/api/organization/modules/sales", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    const list = await http(cookieA, "/api/leads");
    expect(list.status).toBe(200);
    expect(list.body.data.some((l: { id: string }) => l.id === A.leadId)).toBe(true);

    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, A.orgId), eq(auditLogs.action, "org.module_updated")));
    expect(logs.map((l) => (l.metadata as { enabled: boolean }).enabled).sort()).toEqual([false, true]);
  });

  it("one organization's toggle never affects another", async () => {
    expect((await http(cookieB, "/api/leads")).status).toBe(403);
    expect((await http(cookieA, "/api/leads")).status).toBe(200);
  });
});
