import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { siteVisitsService } from "../../site-visits/site-visits.service.js";
import { ConflictError, ValidationError } from "../../../shared/errors.js";

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

    // The model may only book a slot that check_visit_slots currently offers; anything else is refused here, before
    // any booking exists, so the call can neither claim nor record a visit at a time nobody offered.
    const wanted = new Date(args.isoDateTime).getTime();
    const offered = siteVisitsService.checkVisitSlots();
    if (!offered.some((s) => new Date(s.isoDateTime).getTime() === wanted)) {
      return { booked: false, error: "That time is not an available slot. Offer one of the available slots instead.", availableSlots: offered.map((s) => ({ label: s.label, isoDateTime: s.isoDateTime })) };
    }

    let visit;
    try {
      visit = await siteVisitsService.bookSiteVisit(toolContext(ctx), {
        leadId,
        projectId,
        isoDateTime: args.isoDateTime,
        source: "agent",
      });
    } catch (err) {
      // One upcoming visit per lead: tell the model what already exists instead of booking a duplicate.
      if (err instanceof ConflictError) {
        return { booked: false, alreadyBooked: true, error: "This customer already has a site visit booked. Confirm that visit instead of booking another." };
      }
      throw err;
    }

    return {
      booked: true,
      scheduledAt: visit.scheduledAt,
      visitId: visit.id,
    };
  },
};
