import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

export const getProjectLocation: AiTool = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_location",
    description: "Get the project's location, address, and nearby landmarks.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_location needs a project on this call" };
    const [location] = await projectsService.getKnowledgeByCategory(toolContext(ctx), {
      projectId,
      category: "location",
    });

    if (!location) return { error: "Location information not available" };
    return location.content;
  },
};
