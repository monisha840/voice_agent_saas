import { describe, it, expect, beforeAll } from "vitest";
import type { RequestContext } from "../../auth/context.js";
import { demoContext } from "../../test/helpers.js";
import { projectsService } from "./projects.service.js";

describe("projectsService (against seeded DB)", () => {
  let ctx: RequestContext;
  beforeAll(async () => {
    ctx = await demoContext();
  });

  it("getDefaultProject returns the seeded Green Valley Residency project", async () => {
    const project = await projectsService.getDefaultProject(ctx);
    expect(project.name).toBe("Green Valley Residency");
    expect(project.location).toContain("Bangalore");
  });

  it("getKnowledgeByCategory returns pricing with 2 BHK and 3 BHK ranges", async () => {
    const project = await projectsService.getDefaultProject(ctx);
    const [pricing] = await projectsService.getKnowledgeByCategory(ctx, {
      projectId: project.id,
      category: "pricing",
    });

    expect(pricing).toBeTruthy();
    const content = pricing.content as { ranges: Array<{ type: string }> };
    expect(content.ranges.map((r) => r.type)).toEqual(expect.arrayContaining(["2 BHK", "3 BHK"]));
  });

  it("getProjectWithKnowledge includes all 6 knowledge categories", async () => {
    const project = await projectsService.getDefaultProject(ctx);
    const full = await projectsService.getProjectWithKnowledge(ctx, { projectId: project.id });

    expect(full).not.toBeNull();
    const categories = full!.knowledge.map((k) => k.category);
    expect(categories).toEqual(
      expect.arrayContaining(["pricing", "configurations", "amenities", "possession", "location", "faq"]),
    );
  });
});
