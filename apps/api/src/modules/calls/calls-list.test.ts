import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { calls, leads } from "../../db/schema.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

type Body = { data: { id: string; leadName: string | null; status: string; summary: string | null }[]; nextBefore: string | null; error?: string };

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant; // sales module off: the calls list is a core view
let cookieA: string;
let cookieB: string;
let agentCookie: string;
const extraCallIds: string[] = [];

async function get(cookie: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Body };
}

beforeAll(async () => {
  A = await createTenant("CL_A");
  B = await createTenant("CL_B", { modules: [] });

  // A second lead (assigned to an AGENT) with two more calls on tenant A, created later so they sort first.
  const agent = await createMember(A.orgId, "AGENT");
  const agentRow = (await import("../../db/schema.js")).users;
  const [agentUser] = await db.select().from(agentRow).where(eq(agentRow.email, agent.email));
  const [lead2] = await db
    .insert(leads)
    .values({ organizationId: A.orgId, projectId: A.projectId, name: "Assigned Lead", phone: "+919000010009", assignedUserId: agentUser.id })
    .returning();
  for (const status of ["failed", "in_progress"] as const) {
    const [c] = await db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, leadId: lead2.id, status }).returning();
    extraCallIds.push(c.id);
  }

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
  agentCookie = await loginCookie(baseUrl, agent.email);
});

afterAll(async () => {
  await app.close();
  await cleanupTenants();
});

describe("GET /api/calls", () => {
  it("lists the organization's calls newest first, with lead and summary", async () => {
    const res = await get(cookieA, "/api/calls");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[2]).toMatchObject({ id: A.callId, leadName: "CL_A Lead", status: "completed", summary: "summary of CL_A" });
    expect(res.body.data.slice(0, 2).map((c) => c.id).sort()).toEqual([...extraCallIds].sort());
    expect(res.body.nextBefore).toBeNull();
  });

  it("never returns another organization's calls", async () => {
    const a = await get(cookieA, "/api/calls");
    const b = await get(cookieB, "/api/calls");
    expect(b.body.data.map((c) => c.id)).toEqual([B.callId]);
    expect(a.body.data.map((c) => c.id)).not.toContain(B.callId);
    expect(JSON.stringify(b.body)).not.toContain("CL_A");
  });

  it("works for an organization without the sales module (core view)", async () => {
    expect((await get(cookieB, "/api/calls")).status).toBe(200);
  });

  it("an AGENT sees only calls on leads assigned to them", async () => {
    const res = await get(agentCookie, "/api/calls");
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.id).sort()).toEqual([...extraCallIds].sort());
  });

  it("paginates with nextBefore and filters by status", async () => {
    const page1 = await get(cookieA, "/api/calls?limit=2");
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await get(cookieA, `/api/calls?limit=2&before=${encodeURIComponent(page1.body.nextBefore!)}`);
    expect(page2.body.data.map((c) => c.id)).toContain(A.callId);
    expect(page2.body.nextBefore).toBeNull();

    const failed = await get(cookieA, "/api/calls?status=failed");
    expect(failed.body.data.map((c) => c.status)).toEqual(["failed"]);
  });

  it("rejects bad parameters and unauthenticated requests", async () => {
    expect((await get(cookieA, "/api/calls?limit=0")).status).toBe(400);
    expect((await get(cookieA, "/api/calls?status=bogus")).status).toBe(400);
    expect((await get(cookieA, "/api/calls?before=nope")).status).toBe(400);
    expect((await get("", "/api/calls")).status).toBe(401);
  });
});
