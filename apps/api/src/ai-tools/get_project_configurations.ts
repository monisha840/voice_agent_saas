import type { AiTool } from "./types.js";
import { projectsService } from "../modules/projects/projects.service.js";

export const getProjectConfigurations: AiTool = {
  definition: {
    name: "get_project_configurations",
    description: "Get the available unit configurations (e.g. 2 BHK, 3 BHK) and their sizes.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const [configurations] = await projectsService.getKnowledgeByCategory({
      projectId: ctx.projectId,
      category: "configurations",
    });

    if (!configurations) return { error: "Configuration information not available" };
    return configurations.content;
  },
};
