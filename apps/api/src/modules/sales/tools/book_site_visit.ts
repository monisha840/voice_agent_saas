import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { siteVisitsService } from "../../site-visits/site-visits.service.js";
import { ValidationError } from "../../../shared/errors.js";

interface Args {
  isoDateTime: string;
}

export const bookSiteVisit: AiTool<Args> = {
  module: "sales",
  requires: ["lead", "project"],
  definition: {
    name: "book_site_visit",
    description:
      "Book a site visit for the lead at the chosen slot. The isoDateTime must be one of the slots returned by check_visit_slots.",
    parameters: {
      type: "object",
      properties: {
        isoDateTime: { type: "string", description: "ISO 8601 date-time of the chosen slot" },
      },
      required: ["isoDateTime"],
    },
  },
  async execute(args, ctx) {
    if (!args.isoDateTime) {
      throw new ValidationError("book_site_visit requires isoDateTime");
    }

    const { leadId, projectId } = salesSubject(ctx);
    if (!leadId) return { error: "book_site_visit needs a lead on this call" };
    if (!projectId) return { error: "book_site_visit needs a project on this call" };

    const visit = await siteVisitsService.bookSiteVisit(toolContext(ctx), {
      leadId,
      projectId,
      isoDateTime: args.isoDateTime,
    });

    return {
      booked: true,
      scheduledAt: visit.scheduledAt,
      visitId: visit.id,
    };
  },
};
