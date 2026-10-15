import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs } from "../../db/schema.js";
import { cleanupTenants, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let cookieA: string;
let cookieB: string;

async function http(cookie: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  return { status: res.status, body: (await res.json()) as { data: Record<string, unknown> } };
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
});

afterAll(async () => {
  await app.close();
  for (const t of [A, B]) await db.delete(auditLogs).where(eq(auditLogs.organizationId, t.orgId));
  await cleanupTenants();
});

describe("organization settings", () => {
  it("GET returns the caller's own organization with their role", async () => {
    const res = await http(cookieA, "/api/organization");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: A.orgId, name: "Tenant A", role: "OWNER" });
    expect(typeof res.body.data.slug).toBe("string");
  });

  it("PATCH renames, trims, audits, and leaves other organizations untouched", async () => {
    const res = await http(cookieA, "/api/organization", { method: "PATCH", body: JSON.stringify({ name: "  Acme Realty  " }) });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Acme Realty");
    expect((await http(cookieB, "/api/organization")).body.data.name).toBe("Tenant B");
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, A.orgId), eq(auditLogs.action, "org.updated")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: A.userId, entityId: A.orgId });
    expect(audit[0].metadata).toEqual({ from: "Tenant A", to: "Acme Realty" });
  });

  it("PATCH validates the name", async () => {
    for (const name of ["", "   ", "x".repeat(201), 42]) {
      const res = await http(cookieA, "/api/organization", { method: "PATCH", body: JSON.stringify({ name }) });
      expect(res.status).toBe(400);
    }
    expect((await http(cookieA, "/api/organization", { method: "PATCH", body: JSON.stringify({}) })).status).toBe(400);
  });
});
