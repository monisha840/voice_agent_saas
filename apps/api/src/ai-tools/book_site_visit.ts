import type { AiTool } from "./types.js";
import { siteVisitsService } from "../modules/site-visits/site-visits.service.js";
import { ValidationError } from "../shared/errors.js";

interface Args {
  isoDateTime: string;
}

export const bookSiteVisit: AiTool<Args> = {
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

    const visit = await siteVisitsService.bookSiteVisit({
      leadId: ctx.leadId,
      projectId: ctx.projectId,
      isoDateTime: args.isoDateTime,
    });

    return {
      booked: true,
      scheduledAt: visit.scheduledAt,
      visitId: visit.id,
    };
  },
};
