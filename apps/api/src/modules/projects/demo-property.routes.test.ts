/**
 * The temporary read-only property endpoint for Exotel's built-in Voice Agent API Integration. Real HTTP + Postgres.
 * Covers: off by default, auth (header / bearer / basic / ?token=), allowlisted topics only, no data from other
 * projects or organizations, read-only, and that it is reachable through a tunnel (X-Forwarded-*) where the rest of the
 * API is not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";

import { adminDb as db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { projectsRepository } from "../../test/repos.js";
import { redactUrl } from "../../security/telephony-auth.js";
import { resetCallRateLimits } from "../../security/rate-limits.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";
import { startTestApp } from "../../test/agent-first.js";

const KEY = "demo-key-0123456789-abcdefghij-xyz";
const PATH = "/api/telephony/exotel/demo/property-details";

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let projectA = "";
let projectB = "";
let archivedProject = "";

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  A = await createTenant("demo-prop-a");
  B = await createTenant("demo-prop-b");
  const [pa] = await db.insert(projects).values({ organizationId: A.orgId, name: "Demo Heights", location: "Chennai" }).returning();
  const [pb] = await db.insert(projects).values({ organizationId: B.orgId, name: "Other Org Towers", location: "Pune" }).returning();
  const [pz] = await db
    .insert(projects)
    .values({ organizationId: A.orgId, name: "Old Project", location: "Chennai", status: "archived" })
    .returning();
  projectA = pa.id;
  projectB = pb.id;
  archivedProject = pz.id;
  await projectsRepository.upsertKnowledge({ organizationId: A.orgId, projectId: projectA, category: "pricing", content: { startingPrice: 7500000, currency: "INR" } });
  await projectsRepository.upsertKnowledge({ organizationId: A.orgId, projectId: projectA, category: "location", content: { area: "OMR" } });
  await projectsRepository.upsertKnowledge({ organizationId: B.orgId, projectId: projectB, category: "pricing", content: { startingPrice: 1 } });
  ({ app, baseUrl } = await startTestApp());
});

afterAll(async () => {
  await app.close();
  await db.delete(projects).where(eq(projects.id, archivedProject));
  await cleanupTenants();
});

function configure(over: { key?: string; project?: string }) {
  process.env.EXOTEL_DEMO_API_KEY = over.key ?? "";
  process.env.EXOTEL_DEMO_PROJECT_ID = over.project ?? "";
  resetCallRateLimits();
}

describe("demo property endpoint", () => {
  it("is off (404) unless both the key and the project are configured, or the key is short", async () => {
    configure({});
    expect((await get(PATH, { "x-api-key": KEY })).status).toBe(404);
    configure({ key: KEY });
    expect((await get(PATH, { "x-api-key": KEY })).status).toBe(404);
    configure({ project: projectA });
    expect((await get(PATH, { "x-api-key": KEY })).status).toBe(404);
    configure({ key: "short", project: projectA });
    expect((await get(PATH, { "x-api-key": "short" })).status).toBe(404);
  });

  it("rejects a missing or wrong key", async () => {
    configure({ key: KEY, project: projectA });
    expect((await get(PATH)).status).toBe(401);
    expect((await get(PATH, { "x-api-key": "wrong-key-wrong-key-wrong-key" })).status).toBe(401);
    expect((await get(`${PATH}?token=nope`)).status).toBe(401);
  });

  it("accepts the key as x-api-key, Bearer, Basic password or ?token=", async () => {
    configure({ key: KEY, project: projectA });
    const basic = `Basic ${Buffer.from(`exotel:${KEY}`).toString("base64")}`;
    for (const res of [
      await get(PATH, { "x-api-key": KEY }),
      await get(PATH, { authorization: `Bearer ${KEY}` }),
      await get(PATH, { authorization: basic }),
      await get(`${PATH}?token=${KEY}`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.body.project.name).toBe("Demo Heights");
    }
  });

  it("accepts the key as a path segment, and masks it in logged URLs", async () => {
    configure({ key: KEY, project: projectA });
    const ok = await get(`/api/telephony/exotel/demo/k/${KEY}/property-details?topic=pricing`);
    expect(ok.status).toBe(200);
    expect(ok.body.topic).toBe("pricing");
    expect((await get("/api/telephony/exotel/demo/k/wrong-key-wrong-key-wrong-key/property-details")).status).toBe(401);
    expect(redactUrl(`/api/telephony/exotel/demo/k/${KEY}/property-details?topic=pricing`)).toBe(
      "/api/telephony/exotel/demo/k/[redacted]/property-details?topic=pricing",
    );
  });

  it("lists the available topics, and returns one topic's approved content", async () => {
    configure({ key: KEY, project: projectA });
    const list = await get(PATH, { "x-api-key": KEY });
    expect(list.body.availableTopics.sort()).toEqual(["location", "pricing"]);
    const pricing = await get(`${PATH}?topic=pricing`, { "x-api-key": KEY });
    expect(pricing.status).toBe(200);
    expect(pricing.body).toEqual({
      project: { name: "Demo Heights", location: "Chennai" },
      topic: "pricing",
      info: { startingPrice: 7500000, currency: "INR" },
    });
  });

  it("refuses an unknown topic, a topic with no data, and anything not in the allowlist", async () => {
    configure({ key: KEY, project: projectA });
    for (const topic of ["leads", "users", "faq", "../etc", "pricing%20"]) {
      const res = await get(`${PATH}?topic=${topic}`, { "x-api-key": KEY });
      expect(res.status).toBe(400);
      expect(res.body.availableTopics).toBeDefined();
    }
  });

  it("only ever serves the configured project, never another project or organization", async () => {
    configure({ key: KEY, project: projectA });
    const res = await get(`${PATH}?topic=pricing&projectId=${projectB}&organizationId=${B.orgId}`, { "x-api-key": KEY });
    expect(res.body.project.name).toBe("Demo Heights");
    expect(JSON.stringify(res.body)).not.toContain("Other Org");
  });

  it("404s for an archived or unknown demo project", async () => {
    configure({ key: KEY, project: archivedProject });
    expect((await get(PATH, { "x-api-key": KEY })).status).toBe(404);
    configure({ key: KEY, project: "00000000-0000-4000-8000-000000000000" });
    expect((await get(PATH, { "x-api-key": KEY })).status).toBe(404);
  });

  it("is read-only", async () => {
    configure({ key: KEY, project: projectA });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${baseUrl}${PATH}`, { method, headers: { "x-api-key": KEY } });
      expect([404, 405]).toContain(res.status);
    }
  });

  it("is reachable through a tunnel, where the dashboard API is not", async () => {
    configure({ key: KEY, project: projectA });
    const tunnel = { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "demo.example.test", "x-api-key": KEY };
    expect((await get(PATH, tunnel)).status).toBe(200);
    expect((await get("/api/projects", tunnel)).status).toBe(404);
  });

  it("rate-limits per IP", async () => {
    configure({ key: KEY, project: projectA });
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await get(PATH, { "x-api-key": KEY })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
