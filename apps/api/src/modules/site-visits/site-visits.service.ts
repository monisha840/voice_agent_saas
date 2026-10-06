import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import type { RequestContext } from "../../auth/context.js";
import { assertCan, leadScopeFor } from "../../auth/access.js";
import { auditService } from "../audit/audit.service.js";
import { usageService } from "../usage/usage.service.js";

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

  async bookSiteVisit(ctx: RequestContext, params: { leadId: string; projectId: string; isoDateTime: string }) {
    assertCan(ctx, "site-visits:manage");
    const org = ctx.organizationId;
    const scheduledAt = new Date(params.isoDateTime);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new ValidationError(`Invalid slot date/time: ${params.isoDateTime}`);
    }
    // The lead must belong to this organization (the composite foreign keys
    // would also refuse a cross-organization row at the database level).
    const lead = await leadsRepository.findById({ organizationId: org, id: params.leadId, scope: await leadScopeFor(ctx) });
    if (!lead) throw new NotFoundError(`Lead ${params.leadId} not found`);
    const project = await projectsRepository.findById({ organizationId: org, id: params.projectId });
    if (!project) throw new NotFoundError(`Project ${params.projectId} not found`);

    const visit = await siteVisitsRepository.create({
      organizationId: org,
      leadId: params.leadId,
      projectId: params.projectId,
      scheduledAt,
    });
    await leadsRepository.updateStatus({ organizationId: org, id: params.leadId, status: "VISIT_BOOKED" });
    await auditService.record(ctx, {
      action: "site_visit.booked",
      entityType: "site_visit",
      entityId: visit.id,
      metadata: { leadId: params.leadId, projectId: params.projectId, scheduledAt },
    });
    await usageService.recordSiteVisit(ctx, visit);
    return visit;
  },

  async listByLead(ctx: RequestContext, params: { leadId: string }) {
    assertCan(ctx, "site-visits:read");
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: params.leadId, scope: await leadScopeFor(ctx) });
    if (!lead) return [];
    return siteVisitsRepository.listByLead({ organizationId: ctx.organizationId, leadId: params.leadId });
  },

  async list(ctx: RequestContext) {
    assertCan(ctx, "site-visits:read");
    const all = await siteVisitsRepository.list({ organizationId: ctx.organizationId });
    const scope = await leadScopeFor(ctx);
    if (scope.kind === "all") return all;
    const visible = new Set((await leadsRepository.list({ organizationId: ctx.organizationId, scope })).map((l) => l.id));
    return all.filter((v) => visible.has(v.leadId));
  },

  async getById(ctx: RequestContext, params: { id: string }) {
    assertCan(ctx, "site-visits:read");
    const visit = await siteVisitsRepository.findById({ organizationId: ctx.organizationId, id: params.id });
    if (!visit) return null;
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: visit.leadId, scope: await leadScopeFor(ctx) });
    return lead ? visit : null;
  },
};
