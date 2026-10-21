import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { leadsService } from "../../leads/leads.service.js";

interface Args {
  requirementConfig?: string;
  budgetMin?: number;
  budgetMax?: number;
}

export const updateLead: AiTool<Args> = {
  module: "sales",
  requires: ["lead"],
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
    const leadId = salesSubject(ctx).leadId;
    if (!leadId) return { error: "update_lead needs a lead on this call" };
    const updated = await leadsService.updateLead(toolContext(ctx), {
      leadId,
      requirementConfig: args.requirementConfig,
      budgetMin: args.budgetMin,
      budgetMax: args.budgetMax,
      status: "QUALIFICATION",
    });
    return { updated: Boolean(updated) };
  },
};
