import type { AiTool } from "./types.js";
import { projectsService } from "../modules/projects/projects.service.js";

export const getProjectLocation: AiTool = {
  definition: {
    name: "get_project_location",
    description: "Get the project's location, address, and nearby landmarks.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const [location] = await projectsService.getKnowledgeByCategory({
      projectId: ctx.projectId,
      category: "location",
    });

    if (!location) return { error: "Location information not available" };
    return location.content;
  },
};
