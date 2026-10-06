import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { leadsService } from "../../leads/leads.service.js";

export const markNotInterested: AiTool = {
  module: "sales",
  requires: ["lead"],
  definition: {
    name: "mark_not_interested",
    description: "Mark the lead as not interested. Use when the lead clearly declines and does not want a site visit or follow-up.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const leadId = salesSubject(ctx).leadId;
    if (!leadId) return { error: "mark_not_interested needs a lead on this call" };
    await leadsService.markNotInterested(toolContext(ctx), { leadId });
    return { marked: true };
  },
};
