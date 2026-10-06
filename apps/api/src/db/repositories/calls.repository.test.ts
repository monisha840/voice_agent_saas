import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";

import { db } from "../client.js";
import { calls, leads } from "../schema.js";
import { callsRepository, ownCallsVisibility } from "./calls.repository.js";
import { salesCallVisibility } from "../../modules/sales/sales-call-hooks.js";
import { cleanupTenants, createMember, createTenant, type TestTenant } from "../../test/tenants.js";

let A: TestTenant;
let B: TestTenant;
let leadlessCallId: string;
let agentUserId: string;
let agentLeadCallId: string;

beforeAll(async () => {
  A = await createTenant("CR_A");
  B = await createTenant("CR_B", { modules: [] });
  const [leadless] = await db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, status: "completed" }).returning();
  leadlessCallId = leadless.id;
  const agent = await createMember(A.orgId, "AGENT");
  const { users } = await import("../schema.js");
  [{ id: agentUserId }] = await db.select({ id: users.id }).from(users).where(eq(users.email, agent.email));
  const [lead] = await db
    .insert(leads)
    .values({ organizationId: A.orgId, projectId: A.projectId, name: "Mine", phone: "+919000020001", assignedUserId: agentUserId })
    .returning();
  const [c] = await db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, leadId: lead.id, status: "completed" }).returning();
  agentLeadCallId = c.id;
});

afterAll(cleanupTenants);

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("callsRepository is generic", () => {
  it("source does not reference leads", () => {
    const src = readFileSync(new URL("./calls.repository.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bleads\b/);
    expect(src).not.toMatch(/auth\/scope/);
  });

  it("lists calls without any lead data (no lead columns, leadless calls included)", async () => {
    const rows = await callsRepository.list({ organizationId: A.orgId, limit: 50 });
    expect(ids(rows)).toEqual(ids([{ id: A.callId }, { id: leadlessCallId }, { id: agentLeadCallId }]));
    for (const r of rows) {
      expect(r).not.toHaveProperty("leadName");
      expect(r).not.toHaveProperty("leadPhone");
      expect(r).toHaveProperty("leadId"); // kept for backwards compatibility
    }
  });

  it("never crosses organizations, with or without a visibility condition", async () => {
    const b = await callsRepository.list({ organizationId: B.orgId, limit: 50 });
    expect(ids(b)).toEqual([B.callId]);
    expect(await callsRepository.findByIdVisible({ organizationId: B.orgId, id: A.callId })).toBeNull();
    expect(
      await callsRepository.findByIdVisible({ organizationId: B.orgId, id: A.callId, visibility: ownCallsVisibility({ userId: agentUserId, includeUnassociated: true }) }),
    ).toBeNull();
  });

  it("applies a visibility condition in SQL to both list and single read", async () => {
    const visibility = salesCallVisibility({ kind: "assigned", userId: agentUserId })!;
    expect(ids(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility }))).toEqual([agentLeadCallId]);
    expect(await callsRepository.findByIdVisible({ organizationId: A.orgId, id: agentLeadCallId, visibility })).not.toBeNull();
    expect(await callsRepository.findByIdVisible({ organizationId: A.orgId, id: A.callId, visibility })).toBeNull();
  });

  it("the Sales manager rule: leads in their projects plus leadless calls; none -> leadless only", async () => {
    const inProject = salesCallVisibility({ kind: "projects", projectIds: [A.projectId] })!;
    expect(ids(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility: inProject }))).toEqual(
      ids([{ id: A.callId }, { id: leadlessCallId }, { id: agentLeadCallId }]),
    );
    const none = salesCallVisibility({ kind: "projects", projectIds: [] })!;
    expect(ids(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility: none }))).toEqual([leadlessCallId]);
    expect(salesCallVisibility({ kind: "all" })).toBeNull();
  });

  it("a lead of another organization can never grant visibility", async () => {
    // Project ids from tenant B do not match tenant A's leads, even though the SQL is correlated by organization.
    const foreign = salesCallVisibility({ kind: "projects", projectIds: [B.projectId] })!;
    expect(ids(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility: foreign }))).toEqual([leadlessCallId]);
  });

  it("core default (no module): own calls, plus unassociated calls for managers", async () => {
    const own = ownCallsVisibility({ userId: agentUserId, includeUnassociated: false });
    expect(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility: own })).toEqual([]);
    const mgr = ownCallsVisibility({ userId: agentUserId, includeUnassociated: true });
    expect(ids(await callsRepository.list({ organizationId: A.orgId, limit: 50, visibility: mgr }))).toEqual([leadlessCallId]);
  });
});
