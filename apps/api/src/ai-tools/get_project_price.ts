import type { AiTool } from "./types.js";
import { projectsService } from "../modules/projects/projects.service.js";

interface Args {
  configuration?: string;
}

export const getProjectPrice: AiTool<Args> = {
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
    const [pricing] = await projectsService.getKnowledgeByCategory({
      projectId: ctx.projectId,
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
