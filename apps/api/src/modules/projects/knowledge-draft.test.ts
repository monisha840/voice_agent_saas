import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { buildDraftMessages, parseKnowledgeDraft, MAX_DRAFT_SOURCE_CHARS } from "./knowledge-draft.js";
import { projectsService } from "./projects.service.js";
import { setLlmProvider } from "../../adapters/ai/index.js";
import type { ILanguageModel } from "../../adapters/ai/llm.interface.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant, type TestTenant } from "../../test/tenants.js";

describe("parseKnowledgeDraft", () => {
  it("keeps categories that pass their schema and reports the ones that do not", () => {
    const raw = JSON.stringify({
      nearby: { items: [{ name: "Metro", type: "metro", distanceKm: 1.2 }] },
      pricing: { ranges: [{ type: "2 BHK", min: 9, max: 1 }] },
      secrets: { x: 1 },
    });
    const d = parseKnowledgeDraft(raw);
    expect(Object.keys(d.drafts)).toEqual(["nearby"]);
    expect(d.rejected.map((r) => r.category).sort()).toEqual(["pricing", "secrets"]);
    expect(d.rejected.find((r) => r.category === "pricing")!.reason).toMatch(/max/);
  });

  it("accepts JSON the model wrapped in words or a code fence", () => {
    const raw = 'Here is the draft:\n```json\n{"about":{"text":"A gated community in Whitefield."}}\n```\nLet me know.';
    expect(parseKnowledgeDraft(raw).drafts).toEqual({ about: { text: "A gated community in Whitefield." } });
  });

  it("returns nothing for text that is not a JSON object", () => {
    for (const raw of ["", "I could not find facts.", "[1,2,3]", "{not json}"]) {
      expect(parseKnowledgeDraft(raw)).toEqual({ drafts: {}, rejected: [] });
    }
  });

  it("strips keys the schema does not know and applies defaults", () => {
    const d = parseKnowledgeDraft(JSON.stringify({ pricing: { ranges: [], injected: "x" } }));
    expect(d.drafts.pricing).toEqual({ currency: "INR", ranges: [] });
  });

  it("limits the source text it sends", () => {
    const msgs = buildDraftMessages("x".repeat(MAX_DRAFT_SOURCE_CHARS + 500));
    expect(msgs[1].content).toHaveLength(MAX_DRAFT_SOURCE_CHARS);
    expect(msgs[0].content).toContain("Never guess");
  });
});

describe("projectsService.draftKnowledge", () => {
  let A: TestTenant;
  let owner: RequestContext;
  let agent: RequestContext;
  const seen: string[] = [];

  beforeAll(async () => {
    A = await createTenant("KDR");
    owner = userContext(A.orgId, A.userId, "OWNER");
    const m = await createMember(A.orgId, "AGENT");
    agent = userContext(A.orgId, m.userId, "AGENT");
    const model: ILanguageModel = {
      name: "draft-model",
      async chat(messages) {
        seen.push(messages[messages.length - 1].content);
        return { content: '{"builder":{"name":"Acme Homes","yearsInBusiness":12},"nearby":{"items":[{"name":"Hospital","type":"hospital","distanceKm":2}]}}' };
      },
    };
    setLlmProvider(model);
  });
  afterAll(async () => {
    setLlmProvider(null);
    await cleanupTenants();
  });

  it("returns a validated proposal and writes nothing", async () => {
    const before = (await projectsService.getProjectWithKnowledge(owner, { projectId: A.projectId }))!.knowledge.length;
    const d = await projectsService.draftKnowledge(owner, { projectId: A.projectId, text: "Acme Homes, 12 years. Hospital 2 km away. Brochure text here." });
    expect(d!.drafts).toMatchObject({ builder: { name: "Acme Homes" }, nearby: { items: [{ name: "Hospital" }] } });
    expect(seen.at(-1)).toContain("Acme Homes");
    const after = (await projectsService.getProjectWithKnowledge(owner, { projectId: A.projectId }))!.knowledge.length;
    expect(after).toBe(before);
  });

  it("is not available to a role that cannot edit the project, and not for another organization's project", async () => {
    await expect(projectsService.draftKnowledge(agent, { projectId: A.projectId, text: "x".repeat(40) })).rejects.toThrow();
    const other = await createTenant("KDR2");
    const ownerOther = userContext(other.orgId, other.userId, "OWNER");
    expect(await projectsService.draftKnowledge(ownerOther, { projectId: A.projectId, text: "x".repeat(40) })).toBeNull();
  });
});
