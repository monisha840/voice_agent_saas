import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

interface Args {
  configuration?: string;
}

export const getProjectPrice: AiTool<Args> = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_price",
    description:
      "Get approved pricing for a given unit configuration (e.g. '2 BHK', '3 BHK'). Only returns data from approved project knowledge — never invent a price.",
    parameters: {
      type: "object",
      properties: {
        configuration: { type: "string", description: "Unit configuration, e.g. '2 BHK'" },
      },
      required: [],
    },
  },
  async execute(args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_price needs a project on this call" };
    const [pricing] = await projectsService.getKnowledgeByCategory(toolContext(ctx), {
      projectId,
      category: "pricing",
    });

    if (!pricing) return { error: "Pricing information not available" };

    const content = pricing.content as {
      currency: string;
      ranges: Array<{ type: string; min: number; max: number }>;
      notes?: string;
    };

    if (args.configuration) {
      const match = content.ranges.find(
        (r) => r.type.toLowerCase() === args.configuration!.toLowerCase(),
      );
      if (!match) {
        return { error: `No pricing found for configuration "${args.configuration}"` };
      }
      return { configuration: match.type, min: match.min, max: match.max, currency: content.currency, notes: content.notes };
    }

    return content;
  },
};
