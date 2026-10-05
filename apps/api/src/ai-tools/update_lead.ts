import type { AiTool } from "./types.js";
import { leadsService } from "../modules/leads/leads.service.js";

interface Args {
  requirementConfig?: string;
  budgetMin?: number;
  budgetMax?: number;
}

export const updateLead: AiTool<Args> = {
  definition: {
    name: "update_lead",
    description:
      "Update the lead's requirement/budget as understood from the conversation so far (e.g. confirmed configuration or a refined budget range).",
    parameters: {
      type: "object",
      properties: {
        requirementConfig: { type: "string", description: "e.g. '2 BHK', '3 BHK'" },
        budgetMin: { type: "number" },
        budgetMax: { type: "number" },
      },
      required: [],
    },
  },
  async execute(args, ctx) {
    const updated = await leadsService.updateLead({
      leadId: ctx.leadId,
      requirementConfig: args.requirementConfig,
      budgetMin: args.budgetMin,
      budgetMax: args.budgetMax,
      status: "QUALIFICATION",
    });
    return { updated: Boolean(updated) };
  },
};
