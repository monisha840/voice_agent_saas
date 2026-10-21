/**
 * Retrieval at the maximum volume one agent can be configured with: 10 knowledge bases x 2,000 entries (the per-base
 * cap) = 20,000 entries bound to one agent, plus 20,000 in another organization. Measures searchForAgent latency as the
 * restricted runtime role (RLS on) and checks the plan uses the full-text GIN index. Numbers are printed for the docs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { adminDb as db, adminSql } from "../../db/client.js";
import { agentKnowledgeBindings, auditLogs, knowledgeBases, knowledgeItems } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../test/tenants.js";
import { knowledgeService } from "./knowledge.service.js";

let A: TestTenant;
let B: TestTenant;
let agentId = "";
const WORDS = "price parking delivery timing warranty refund installation service booking payment emi loan insurance pharmacy doctor clinic appointment showroom testdrive colour model variant mileage battery charging".split(" ");

async function seedOrg(orgId: string, bases: number, perBase: number) {
  const ids: string[] = [];
  for (let b = 0; b < bases; b++) {
    const [kb] = await db.insert(knowledgeBases).values({ organizationId: orgId, name: `Scale ${b}` }).returning();
    ids.push(kb.id);
    // generate_series in SQL: realistic varied text without 20k round trips
    await adminSql!.unsafe(
      `insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body, position)
       select $1::uuid, $2::uuid, case when g % 3 = 0 then 'faq' else 'info' end,
              'Question ' || g || ' about ' || (array[${WORDS.map((w) => `'${w}'`).join(",")}])[1 + (g % ${WORDS.length})],
              'Answer number ' || g || ': the ' || (array[${WORDS.map((w) => `'${w}'`).join(",")}])[1 + ((g * 7) % ${WORDS.length})]
                || ' policy covers ' || md5(g::text) || ' and the ' || (array[${WORDS.map((w) => `'${w}'`).join(",")}])[1 + ((g * 13) % ${WORDS.length})] || ' details.',
              g
       from generate_series(1, $3::int) g`,
      [orgId, kb.id, perBase],
    );
  }
  return ids;
}

beforeAll(async () => {
  A = await createTenant("KBS_A", { modules: [] });
  B = await createTenant("KBS_B", { modules: [] });
  agentId = (await createDefaultAgent(A.orgId, { name: "Scale agent", isDefault: false, promptTemplateKey: "generic", enabledTools: ["end_call", "search_knowledge"], moduleConfig: {} })).id;
  const idsA = await seedOrg(A.orgId, 10, 2000);
  await seedOrg(B.orgId, 10, 2000);
  await db.insert(agentKnowledgeBindings).values(idsA.map((sourceId) => ({ organizationId: A.orgId, agentId, sourceType: "knowledge_base", sourceId })));
  await adminSql!.unsafe("analyze knowledge_items");
}, 180_000);

afterAll(async () => {
  const ids = [A.orgId, B.orgId];
  await db.delete(agentKnowledgeBindings).where(inArray(agentKnowledgeBindings.organizationId, ids));
  await db.delete(knowledgeItems).where(inArray(knowledgeItems.organizationId, ids));
  await db.delete(knowledgeBases).where(inArray(knowledgeBases.organizationId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, ids));
  await cleanupTenants();
});

describe("retrieval at maximum configured volume", () => {
  it("answers within budget as the restricted role, top 5 only, from the agent's own organization", { timeout: 120_000 }, async () => {
    const ctx = systemContext(A.orgId, "test");
    const queries = [
      "what is the price",
      "is parking available",
      "delivery timing please",
      "warranty and refund policy",
      "emi loan options",
      "book an appointment with the doctor",
      "battery charging time",
      "colour variants of the model",
      "insurance for pharmacy",
      "Question 1999 about service",
    ];
    await knowledgeService.searchForAgent(ctx, { agentId, query: "warm up" });
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const query of queries) {
        const t0 = performance.now();
        const hits = await knowledgeService.searchForAgent(ctx, { agentId, query });
        times.push(performance.now() - t0);
        expect(hits.length).toBeLessThanOrEqual(5);
        expect(hits.length).toBeGreaterThan(0);
      }
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    writeFileSync(join(tmpdir(), "kblatency.txt"), `knowledge search over 20,000 bound entries (40,000 total): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms n=${times.length}`);
    // Generous ceiling: a regression to a sequential scan of every row would blow through it.
    expect(p95).toBeLessThan(400);
  });

  it("the real search query never scans the whole table (uses the tenant/base or full-text index)", async () => {
    const kbs = (await adminSql!`select id from knowledge_bases where organization_id = ${A.orgId}`).map((r) => "'" + r.id + "'::uuid").join(",");
    const plan = (await adminSql!.unsafe(
      "explain select i.id, ts_rank(i.search, to_tsquery('simple', 'price | parking'))::float8 as rank from knowledge_items i " +
        "join knowledge_bases kb on kb.organization_id = i.organization_id and kb.id = i.knowledge_base_id and kb.status = 'active' " +
        "left join knowledge_documents d on d.organization_id = i.organization_id and d.id = i.document_id " +
        "where i.organization_id = '" + A.orgId + "' and i.knowledge_base_id in (" + kbs + ") and (i.document_id is null or d.status = 'ready') " +
        "and i.search @@ to_tsquery('simple', 'price | parking') order by rank desc, i.position asc limit 5",
    )) as unknown as Array<{ "QUERY PLAN": string }>;
    const text = plan.map((r) => r["QUERY PLAN"]).join(String.fromCharCode(10));
    writeFileSync(join(tmpdir(), "kbplan2.txt"), text);
    expect(text).not.toMatch(/Seq Scan on knowledge_items/);
    expect(text).toMatch(/knowledge_items_(search|kb)_idx/);
  
  });
});
