import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { siteVisitsService } from "../../site-visits/site-visits.service.js";

export const checkVisitSlots: AiTool = {
  module: "sales",
  requires: ["lead", "project"],
  definition: {
    name: "check_visit_slots",
    description: "Check available site-visit slots for the project. Returns up to 3 slots to offer the lead.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    if (!salesSubject(ctx).leadId) return { error: "check_visit_slots needs a lead on this call" };
    if (!salesSubject(ctx).projectId) return { error: "check_visit_slots needs a project on this call" };
    const slots = siteVisitsService.checkVisitSlots();
    return { slots };
  },
};
