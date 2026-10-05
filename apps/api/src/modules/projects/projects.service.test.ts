import { describe, it, expect } from "vitest";
import { projectsService } from "./projects.service.js";

describe("projectsService (against seeded DB)", () => {
  it("getDefaultProject returns the seeded Green Valley Residency project", async () => {
    const project = await projectsService.getDefaultProject();
    expect(project.name).toBe("Green Valley Residency");
    expect(project.location).toContain("Bangalore");
  });

  it("getKnowledgeByCategory returns pricing with 2 BHK and 3 BHK ranges", async () => {
    const project = await projectsService.getDefaultProject();
    const [pricing] = await projectsService.getKnowledgeByCategory({
      projectId: project.id,
      category: "pricing",
    });

    expect(pricing).toBeTruthy();
    const content = pricing.content as { ranges: Array<{ type: string }> };
    expect(content.ranges.map((r) => r.type)).toEqual(expect.arrayContaining(["2 BHK", "3 BHK"]));
  });

  it("getProjectWithKnowledge includes all 6 knowledge categories", async () => {
    const project = await projectsService.getDefaultProject();
    const full = await projectsService.getProjectWithKnowledge({ projectId: project.id });

    expect(full).not.toBeNull();
    const categories = full!.knowledge.map((k) => k.category);
    expect(categories).toEqual(
      expect.arrayContaining(["pricing", "configurations", "amenities", "possession", "location", "faq"]),
    );
  });
});
