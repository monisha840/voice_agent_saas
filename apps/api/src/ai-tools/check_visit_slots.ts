import type { AiTool } from "./types.js";
import { siteVisitsService } from "../modules/site-visits/site-visits.service.js";

export const checkVisitSlots: AiTool = {
  definition: {
    name: "check_visit_slots",
    description: "Check available site-visit slots for the project. Returns up to 3 slots to offer the lead.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute() {
    const slots = siteVisitsService.checkVisitSlots();
    return { slots };
  },
};
