import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

export const getProjectConfigurations: AiTool = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_configurations",
    description: "Get the available unit configurations (e.g. 2 BHK, 3 BHK) and their sizes.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_configurations needs a project on this call" };
    const [configurations] = await projectsService.getKnowledgeByCategory(toolContext(ctx), {
      projectId,
      category: "configurations",
    });

    if (!configurations) return { error: "Configuration information not available" };
    return configurations.content;
  },
};
