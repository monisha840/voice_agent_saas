/**
 * Migration 0008 (calls belong to an agent; the lead is optional): the backfill UPDATEs, re-run against legacy-shaped
 * rows, and the SET NULL (lead_id) foreign key.
 *
 * Legacy rows (agent_id NULL) cannot be inserted into the real calls table once a later migration makes agent_id
 * required, so the backfill runs against a TEMP table `calls` (same columns) that shadows public.calls inside one
 * transaction (pg_temp is searched first); leads, agents, bindings and organizations are the real tables. The
 * statements themselves are read verbatim from the migration file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

import { adminDb as db, adminSql } from "./client.js";

// Migrations run as the administrative (owner) role, not as the restricted runtime role.
const sql = adminSql!;
import { agentKnowledgeBindings, calls, conversations, leads, projects } from "./schema.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";

let backfill: string[];
let A: TestTenant;
let B: TestTenant;

// fixtures (org A)
let boundAgentId = ""; // oldest agent bound to A's project
let laterBoundAgentId = ""; // a second, newer agent bound to the same project
let archivedBoundAgentId = "";
let unboundLeadId = "";
let archivedProjectLeadId = "";

interface Row {
  id: string;
  organization_id: string;
  lead_id: string | null;
  agent_id: string | null;
  counterparty_number: string | null;
  counterparty_name: string | null;
}

const ids = {} as Record<"viaBinding" | "viaDefault" | "preset" | "leadless" | "archivedBinding" | "orgB", string>;

/** Creates the temp calls table with the legacy rows, runs the backfill `times` times, and returns the rows after each run. */
async function runBackfill(times: number): Promise<{ before: Row[]; after: Row[][] }> {
  const result = await sql.begin(async (tx) => {
    await tx.unsafe("CREATE TEMP TABLE calls (LIKE public.calls INCLUDING DEFAULTS) ON COMMIT DROP");
    await tx.unsafe("ALTER TABLE pg_temp.calls ALTER COLUMN agent_id DROP NOT NULL"); // the legacy shape
    const insert = async (key: keyof typeof ids, v: { org: string; lead: string | null; agent?: string | null; number?: string | null; name?: string | null }) => {
      const rows = await tx.unsafe(
        `INSERT INTO pg_temp.calls (organization_id, lead_id, agent_id, counterparty_number, counterparty_name, status)
         VALUES ($1, $2, $3, $4, $5, 'completed') RETURNING id`,
        [v.org, v.lead, v.agent ?? null, v.number ?? null, v.name ?? null],
      );
      ids[key] = rows[0].id as string;
    };
    await insert("viaBinding", { org: A.orgId, lead: A.leadId });
    await insert("viaDefault", { org: A.orgId, lead: unboundLeadId });
    await insert("preset", { org: A.orgId, lead: A.leadId, agent: A.agentId, number: "+919111111111", name: "Preset name" });
    await insert("leadless", { org: A.orgId, lead: null });
    await insert("archivedBinding", { org: A.orgId, lead: archivedProjectLeadId });
    await insert("orgB", { org: B.orgId, lead: B.leadId });

    const snapshot = async () =>
      (await tx.unsafe("SELECT id, organization_id, lead_id, agent_id, counterparty_number, counterparty_name FROM pg_temp.calls ORDER BY id")) as unknown as Row[];
    const before = await snapshot();
    const after: Row[][] = [];
    for (let i = 0; i < times; i++) {
      for (const stmt of backfill) await tx.unsafe(stmt);
      after.push(await snapshot());
    }
    return { before, after };
  });
  return result as { before: Row[]; after: Row[][] };
}

const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

beforeAll(async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const migrations = join(dir, "migrations");
  const file = readdirSync(migrations).find((f) => f.startsWith("0008_") && f.endsWith(".sql"))!;
  const text = readFileSync(join(migrations, file), "utf8");
  const start = text.indexOf("-- Expand/contract");
  expect(start).toBeGreaterThan(0);
  backfill = text
    .slice(start)
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(backfill).toHaveLength(2);
  expect(backfill.every((s) => /\bUPDATE "calls"/.test(s))).toBe(true);

  A = await createTenant("MG_A");
  B = await createTenant("MG_B");

  // A: the project of A.leadId gets two bound agents (oldest wins); a second project has none; a third has only an archived one.
  boundAgentId = (await createDefaultAgent(A.orgId, { name: "MG bound (oldest)", isDefault: false })).id;
  await new Promise((r) => setTimeout(r, 15));
  laterBoundAgentId = (await createDefaultAgent(A.orgId, { name: "MG bound (newer)", isDefault: false })).id;
  for (const agentId of [laterBoundAgentId, boundAgentId]) {
    await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId, sourceType: "project", sourceId: A.projectId });
  }
  const [p2] = await db.insert(projects).values({ organizationId: A.orgId, name: "MG unbound", location: "x" }).returning();
  const [l2] = await db.insert(leads).values({ organizationId: A.orgId, projectId: p2.id, name: "Unbound Lead", phone: "+919222222222" }).returning();
  unboundLeadId = l2.id;
  const [p3] = await db.insert(projects).values({ organizationId: A.orgId, name: "MG archived binding", location: "y" }).returning();
  const [l3] = await db.insert(leads).values({ organizationId: A.orgId, projectId: p3.id, name: "Archived Lead", phone: "+919333333333" }).returning();
  archivedProjectLeadId = l3.id;
  archivedBoundAgentId = (await createDefaultAgent(A.orgId, { name: "MG archived", isDefault: false, status: "archived" })).id;
  await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId: archivedBoundAgentId, sourceType: "project", sourceId: p3.id });
});

afterAll(async () => {
  await cleanupTenants();
});

describe("migration 0008 backfill (legacy rows with agent_id NULL)", () => {
  it("attributes each call to the right agent: the lead's project agent, else the organization default", async () => {
    const { before, after } = await runBackfill(1);
    // the fixtures really are legacy-shaped before the backfill
    for (const key of ["viaBinding", "viaDefault", "leadless", "archivedBinding", "orgB"] as const) {
      expect(byId(before, ids[key]).agent_id).toBeNull();
    }
    const rows = after[0];
    // (a) a call on a lead whose project has an agent binding gets THAT agent (the oldest one when several are bound)
    expect(byId(rows, ids.viaBinding).agent_id).toBe(boundAgentId);
    expect(byId(rows, ids.viaBinding).agent_id).not.toBe(laterBoundAgentId);
    // (b) no binding -> the organization default agent
    expect(byId(rows, ids.viaDefault).agent_id).toBe(A.agentId);
    // an archived bound agent is not used
    expect(byId(rows, ids.archivedBinding).agent_id).toBe(A.agentId);
    expect(byId(rows, ids.archivedBinding).agent_id).not.toBe(archivedBoundAgentId);
    // a call that never had a lead also gets the default agent
    expect(byId(rows, ids.leadless).agent_id).toBe(A.agentId);
    // every agent belongs to the call's own organization
    expect(byId(rows, ids.orgB).agent_id).toBe(B.agentId);
    for (const r of rows) expect(r.agent_id).not.toBeNull();
  });

  it("(c) copies the lead's phone and name to the counterparty (only for calls with a lead)", async () => {
    const { after } = await runBackfill(1);
    const rows = after[0];
    expect(byId(rows, ids.viaBinding)).toMatchObject({ counterparty_number: "+919000010002", counterparty_name: "MG_A Lead" });
    expect(byId(rows, ids.viaDefault)).toMatchObject({ counterparty_number: "+919222222222", counterparty_name: "Unbound Lead" });
    expect(byId(rows, ids.archivedBinding)).toMatchObject({ counterparty_number: "+919333333333", counterparty_name: "Archived Lead" });
    expect(byId(rows, ids.leadless)).toMatchObject({ counterparty_number: null, counterparty_name: null });
    // organization B's call takes B's lead, never A's
    expect(byId(rows, ids.orgB)).toMatchObject({ counterparty_number: "+919000010002", counterparty_name: "MG_B Lead" });
  });

  it("(e) rows that already have an agent and counterparty are untouched", async () => {
    const { before, after } = await runBackfill(1);
    expect(byId(after[0], ids.preset)).toEqual(byId(before, ids.preset));
    expect(byId(after[0], ids.preset)).toMatchObject({ agent_id: A.agentId, counterparty_number: "+919111111111", counterparty_name: "Preset name" });
  });

  it("(d) is idempotent: a second run changes nothing", async () => {
    const { after } = await runBackfill(3);
    expect(after[1]).toEqual(after[0]);
    expect(after[2]).toEqual(after[0]);
  });

  it("never touches the real calls table (the temp table shadowed it)", async () => {
    const real = await db.select().from(calls).where(eq(calls.organizationId, A.orgId));
    expect(real.map((c) => c.id)).not.toContain(ids.viaBinding);
    expect(real.every((c) => c.agentId !== null)).toBe(true);
  });
});

describe("deleting a lead keeps its calls (composite SET NULL (lead_id))", () => {
  it("the foreign key is declared as ON DELETE SET NULL (lead_id)", async () => {
    const rows = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'calls_org_lead_fk'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/ON DELETE SET NULL \(lead_id\)/);
  });

  it("the call stays with lead_id NULL, organization and agent intact, and keeps its transcript and summary", async () => {
    const [callBefore] = await db.select().from(calls).where(eq(calls.id, A.callId));
    expect(callBefore.leadId).toBe(A.leadId);
    const [convBefore] = await db.select().from(conversations).where(eq(conversations.callId, A.callId));
    expect((convBefore.transcript as unknown[]).length).toBeGreaterThan(0);

    await db.delete(leads).where(eq(leads.id, A.leadId));

    const [callAfter] = await db.select().from(calls).where(eq(calls.id, A.callId));
    expect(callAfter).toBeTruthy();
    expect(callAfter.leadId).toBeNull();
    expect(callAfter.organizationId).toBe(A.orgId);
    expect(callAfter.agentId).toBe(A.agentId);
    expect(callAfter.status).toBe(callBefore.status);
    expect(callAfter.providerCallId).toBe(callBefore.providerCallId);

    const [convAfter] = await db.select().from(conversations).where(eq(conversations.callId, A.callId));
    expect(convAfter.id).toBe(convBefore.id);
    expect(convAfter.organizationId).toBe(A.orgId);
    expect(convAfter.transcript).toEqual(convBefore.transcript);
    expect(convAfter.summary).toBe("summary of MG_A");
  });

  it("deleting org B's lead leaves org A's calls alone, and B's call survives as well", async () => {
    await db.delete(leads).where(eq(leads.id, B.leadId));
    const [b] = await db.select().from(calls).where(eq(calls.id, B.callId));
    expect(b).toMatchObject({ leadId: null, organizationId: B.orgId, agentId: B.agentId });
    const [a] = await db.select().from(calls).where(eq(calls.id, A.callId));
    expect(a.organizationId).toBe(A.orgId);
  });
});
