import type { AiTool } from "./types.js";
import { leadsService } from "../modules/leads/leads.service.js";

export const markNotInterested: AiTool = {
  definition: {
    name: "mark_not_interested",
    description: "Mark the lead as not interested. Use when the lead clearly declines and does not want a site visit or follow-up.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    await leadsService.markNotInterested({ leadId: ctx.leadId });
    return { marked: true };
  },
};
