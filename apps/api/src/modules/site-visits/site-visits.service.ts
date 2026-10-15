import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import type { RequestContext } from "../../auth/context.js";
import { assertCan, leadScopeFor } from "../../auth/access.js";
import { auditService } from "../audit/audit.service.js";
import { usageService } from "../usage/usage.service.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

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

/** The zone slot times are expressed in. Servers run in UTC; "10:00 AM" must mean 10:00 where the business is. */
function businessTimeZone(): string {
  return process.env.BUSINESS_TIME_ZONE?.trim() || "Asia/Kolkata";
}

/** The current date and time where the business is, in words ("Tuesday, 13 October 2026, 6:35 pm"), for the agent's prompt. */
export function businessNowDescription(now: Date = new Date()): string {
  const timeZone = businessTimeZone();
  const text = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return `${text} (${timeZone})`;
}

/** Calendar date and weekday of an instant as seen in a time zone. */
function zonedDate(at: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** The instant at which the clock in `timeZone` shows this wall time on this date. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(wallAsUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(wallAsUtc - (shown - wallAsUtc));
}

const siteVisitsServiceImpl = {
  /** Returns the next few demo slots (Saturday mornings/afternoons). */
  checkVisitSlots(now: Date = new Date()): VisitSlot[] {
    const zone = businessTimeZone();
    const today = zonedDate(now, zone);
    const daysToSaturday = (6 + 7 - today.weekday) % 7 || 7;
    const saturday = new Date(Date.UTC(today.year, today.month - 1, today.day + daysToSaturday));

    const slotTimes = [
      { hour: 10, minute: 0, label: "10:00 AM" },
      { hour: 11, minute: 30, label: "11:30 AM" },
      { hour: 14, minute: 0, label: "2:00 PM" },
    ];

    return slotTimes.map((slot, idx) => {
      const dt = zonedInstant(saturday.getUTCFullYear(), saturday.getUTCMonth() + 1, saturday.getUTCDate(), slot.hour, slot.minute, zone);
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

export const siteVisitsService = tenantScoped(siteVisitsServiceImpl);
