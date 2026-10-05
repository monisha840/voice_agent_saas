import type { AiTool } from "./types.js";
import { projectsService } from "../modules/projects/projects.service.js";

export const getProjectDetails: AiTool = {
  definition: {
    name: "get_project_details",
    description:
      "Get general details about the real-estate project: name, location, amenities, possession date, and frequently asked questions (RERA status, loan assistance, booking amount, maintenance charges). Use this for general questions not covered by a more specific tool.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const project = await projectsService.getProjectWithKnowledge({ projectId: ctx.projectId });
    if (!project) return { error: "Project not found" };

    const amenities = project.knowledge.find((k) => k.category === "amenities")?.content;
    const possession = project.knowledge.find((k) => k.category === "possession")?.content;
    const location = project.knowledge.find((k) => k.category === "location")?.content;
    const faq = project.knowledge.find((k) => k.category === "faq")?.content;

    return {
      name: project.name,
      location: project.location,
      amenities,
      possession,
      locationDetails: location,
      faq,
    };
  },
};
