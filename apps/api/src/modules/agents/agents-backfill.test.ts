import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";

import { db, sql } from "../../db/client.js";
import { agentConfigs, agentKnowledgeBindings, agents, calls } from "../../db/schema.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";
import { SALES_TOOL_NAMES } from "../sales/sales-constants.js";

/** The list migration 0007 writes: every tool that existed then (request_follow_up came with migration 0010). */
const LEGACY_SALES_TOOL_NAMES = SALES_TOOL_NAMES.filter((n) => n !== "request_follow_up");

let T1: TestTenant; // org-default config with empty allowed_tools + a project override
let T2: TestTenant; // no config at all
let T3: TestTenant; // config whose allowed_tools lacks end_call
let backfill: string[];

const orgIds = () => [T1.orgId, T2.orgId, T3.orgId];

/**
 * Runs the migration's backfill statements against ONLY the fixture organizations: temp views named like
 * the source tables shadow them (pg_temp is searched first), so other rows in the test database are untouched.
 */
async function runBackfill() {
  const ids = orgIds().map((id) => `'${id}'`).join(",");
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE TEMP VIEW organizations AS SELECT * FROM public.organizations WHERE id IN (${ids})`);
    await tx.unsafe(`CREATE TEMP VIEW agent_configs AS SELECT * FROM public.agent_configs WHERE organization_id IN (${ids})`);
    for (const stmt of backfill) await tx.unsafe(stmt);
    await tx.unsafe("DROP VIEW pg_temp.organizations");
    await tx.unsafe("DROP VIEW pg_temp.agent_configs");
  });
}

beforeAll(async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const migrations = join(dir, "../../db/migrations");
  const file = readdirSync(migrations).find((f) => f.startsWith("0007_") && f.endsWith(".sql"))!;
  const text = readFileSync(join(migrations, file), "utf8");
  backfill = text
    .slice(text.indexOf("-- Backfill"))
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(backfill.length).toBeGreaterThanOrEqual(2);

  T1 = await createTenant("BfA");
  T2 = await createTenant("BfB");
  T3 = await createTenant("BfC");
  // createTenant gives every tenant a default agent (like a migrated org). The backfill is what CREATES that agent from
  // the legacy config, so start from organizations that have none: drop the fixture calls (they reference it) and agents.
  for (const t of [T1, T2, T3]) {
    await db.delete(calls).where(eq(calls.organizationId, t.orgId));
    await db.delete(agents).where(eq(agents.organizationId, t.orgId));
  }
  await db.insert(agentConfigs).values({
    organizationId: T1.orgId,
    projectId: null,
    agentName: "Asha",
    companyName: "Acme Realty",
    greeting: "Hello from Acme",
    disclosureText: "This is an AI assistant.",
    language: "hi-IN",
    tone: "warm",
    callObjective: "Book a visit",
    qualificationQuestions: ["When do you plan to buy?"],
    callBehaviour: { maxResponseSentences: 2, endCallWhenDone: false },
    allowedTools: [],
    siteVisitBehaviour: { offerSlots: 2, autoBook: false },
    extraInstructions: "Be brief",
  });
  await db.insert(agentConfigs).values({
    organizationId: T1.orgId,
    projectId: T1.projectId,
    agentName: "Rohan",
    allowedTools: ["get_project_price"],
  });
  await db.insert(agentConfigs).values({
    organizationId: T3.orgId,
    projectId: null,
    agentName: "Tia",
    allowedTools: ["update_lead", "end_call"],
  });
});

afterAll(async () => {
  await db.delete(agentKnowledgeBindings).where(inArray(agentKnowledgeBindings.organizationId, orgIds()));
  await db.delete(agents).where(inArray(agents.organizationId, orgIds()));
  await cleanupTenants();
});

const forOrg = (orgId: string) => db.select().from(agents).where(eq(agents.organizationId, orgId));

describe("migration 0007 backfill", () => {
  it("creates the default and project agents with the exact legacy mapping, idempotently", async () => {
    await runBackfill();

    // (a) org default config with empty allowed_tools + (b) project override
    const rows1 = await forOrg(T1.orgId);
    expect(rows1).toHaveLength(2);
    const def = rows1.find((r) => r.isDefault)!;
    expect(def).toMatchObject({
      name: "Default agent",
      personaName: "Asha",
      companyName: "Acme Realty",
      greeting: "Hello from Acme",
      disclosureText: "This is an AI assistant.",
      language: "hi-IN",
      tone: "warm",
      callObjective: "Book a visit",
      extraInstructions: "Be brief",
      promptTemplateKey: "sales_real_estate",
      status: "active",
      behaviour: { maxResponseSentences: 2, endCallWhenDone: false, conversationQuestions: ["When do you plan to buy?"] },
      moduleConfig: { sales: { offerSlots: 2, autoBook: false } },
    });
    expect(def.enabledTools).toEqual([...LEGACY_SALES_TOOL_NAMES]);

    const proj = rows1.find((r) => !r.isDefault)!;
    expect(proj).toMatchObject({
      name: `${T1.projectName} agent`,
      personaName: "Rohan",
      companyName: null,
      promptTemplateKey: "sales_real_estate",
      behaviour: { maxResponseSentences: 3, endCallWhenDone: true, conversationQuestions: [] },
      moduleConfig: { sales: { offerSlots: 3, autoBook: true } },
    });
    expect(proj.enabledTools).toEqual(["get_project_price", "end_call"]);
    const bindings = await db.select().from(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.organizationId, T1.orgId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ agentId: proj.id, sourceType: "project", sourceId: T1.projectId });

    // (c) org with no config: built-in defaults, persona Priya, no brand
    const rows2 = await forOrg(T2.orgId);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]).toMatchObject({
      name: "Default agent",
      personaName: "Priya",
      companyName: null,
      greeting: null,
      language: "en-IN",
      tone: "professional",
      isDefault: true,
      promptTemplateKey: "sales_real_estate",
      behaviour: { maxResponseSentences: 3, endCallWhenDone: true, conversationQuestions: [] },
      moduleConfig: { sales: { offerSlots: 3, autoBook: true } },
    });
    expect(rows2[0].enabledTools).toEqual([...LEGACY_SALES_TOOL_NAMES]);
    expect(await db.select().from(agentKnowledgeBindings).where(eq(agentKnowledgeBindings.organizationId, T2.orgId))).toHaveLength(0);

    // allowed_tools without end_call gets it appended
    const rows3 = await forOrg(T3.orgId);
    expect(rows3).toHaveLength(1);
    expect(rows3[0].personaName).toBe("Tia");
    expect(rows3[0].enabledTools).toEqual(["update_lead", "end_call"]);

    // Running it again changes nothing (no duplicates).
    const snapshot = async () =>
      JSON.stringify([
        (await forOrg(T1.orgId)).map((r) => r.id).sort(),
        (await forOrg(T2.orgId)).map((r) => r.id).sort(),
        (await forOrg(T3.orgId)).map((r) => r.id).sort(),
        (await db.select().from(agentKnowledgeBindings).where(inArray(agentKnowledgeBindings.organizationId, orgIds()))).map((r) => r.id).sort(),
      ]);
    const first = await snapshot();
    await runBackfill();
    await runBackfill();
    expect(await snapshot()).toBe(first);

    // agent_configs is untouched
    expect(await db.select().from(agentConfigs).where(inArray(agentConfigs.organizationId, orgIds()))).toHaveLength(3);
  });
});
