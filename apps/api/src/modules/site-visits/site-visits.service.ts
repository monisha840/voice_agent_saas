import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { ValidationError } from "../../shared/errors.js";

/**
 * Service boundary for site-visit scheduling. AI tools (check_visit_slots,
 * book_site_visit) call this service — never the repository directly.
 *
 * Slots are mocked for the MVP per MVP_IMPLEMENTATION_PLAN.md §8: no real
 * calendar integration. Slots are generated relative to "now" so the demo
 * always shows plausible near-future times.
 */

export interface VisitSlot {
  id: string;
  label: string;
  isoDateTime: string;
}

function nextWeekday(from: Date, targetDay: number): Date {
  const d = new Date(from);
  const diff = (targetDay + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

export const siteVisitsService = {
  /** Returns the next few demo slots (Saturday mornings/afternoons). */
  checkVisitSlots(): VisitSlot[] {
    const now = new Date();
    const saturday = nextWeekday(now, 6);

    const slotTimes = [
      { hour: 10, minute: 0, label: "10:00 AM" },
      { hour: 11, minute: 30, label: "11:30 AM" },
      { hour: 14, minute: 0, label: "2:00 PM" },
    ];

    return slotTimes.map((slot, idx) => {
      const dt = new Date(saturday);
      dt.setHours(slot.hour, slot.minute, 0, 0);
      return {
        id: `slot-${idx + 1}`,
        label: `Saturday ${slot.label}`,
        isoDateTime: dt.toISOString(),
      };
    });
  },

  async bookSiteVisit(params: { leadId: string; projectId: string; isoDateTime: string }) {
    const scheduledAt = new Date(params.isoDateTime);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new ValidationError(`Invalid slot date/time: ${params.isoDateTime}`);
    }

    const visit = await siteVisitsRepository.create({
      leadId: params.leadId,
      projectId: params.projectId,
      scheduledAt,
    });

    await leadsRepository.updateStatus({ id: params.leadId, status: "VISIT_BOOKED" });

    return visit;
  },

  async listByLead(params: { leadId: string }) {
    return siteVisitsRepository.listByLead({ leadId: params.leadId });
  },
};
