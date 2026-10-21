import { ActiveVisitExistsError, siteVisitsRepository, type SiteVisitView } from "../../db/repositories/site-visits.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
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
export function businessTimeZone(): string {
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

/** How far ahead a visit may be booked. */
const MAX_DAYS_AHEAD = 180;

function assertBookableTime(scheduledAt: Date, now: Date) {
  if (scheduledAt.getTime() <= now.getTime()) throw new ValidationError("The visit time must be in the future");
  if (scheduledAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    throw new ValidationError(`The visit time must be within ${MAX_DAYS_AHEAD} days`);
  }
}

/** Why a reschedule/cancel was refused, from the visit as it was read. */
function transitionRefusal(visit: { status: string; scheduledAt: Date }, now: Date): string {
  if (visit.status === "cancelled") return "This visit is cancelled and cannot be changed";
  if (visit.scheduledAt.getTime() <= now.getTime()) return "This visit's time has passed and it can no longer be changed";
  return "This visit changed in the meantime; reload and try again";
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

  /**
   * Books a visit (the agent's book_site_visit tool and the dashboard both come here). Rules, enforced for every caller:
   * the lead and project are in this organization and the caller's scope; the time is valid, in the future and at
   * most MAX_DAYS_AHEAD away; and a lead has at most ONE upcoming visit (a second booking is a ConflictError: move
   * the existing one instead). The one-upcoming-visit check is race-safe (per-lead lock in the repository).
   */
  async bookSiteVisit(
    ctx: RequestContext,
    params: { leadId: string; projectId: string; isoDateTime: string; source?: "agent" | "dashboard" },
    now: Date = new Date(),
  ) {
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
    assertBookableTime(scheduledAt, now);

    let visit;
    try {
      visit = await siteVisitsRepository.createUnlessActive({
        organizationId: org,
        leadId: params.leadId,
        projectId: params.projectId,
        scheduledAt,
        now,
      });
    } catch (err) {
      if (err instanceof ActiveVisitExistsError) {
        throw new ConflictError(
          `This lead already has a site visit booked for ${err.existing.scheduledAt.toISOString()}; reschedule or cancel it instead`,
        );
      }
      throw err;
    }
    await leadsRepository.updateStatus({ organizationId: org, id: params.leadId, status: "VISIT_BOOKED" });
    await auditService.record(ctx, {
      action: "site_visit.booked",
      entityType: "site_visit",
      entityId: visit.id,
      metadata: { leadId: params.leadId, projectId: params.projectId, scheduledAt, source: params.source ?? "agent" },
    });
    await usageService.recordSiteVisit(ctx, visit);
    return visit;
  },

  /** Dashboard booking: the project is always the lead's own project (never chosen by the browser). */
  async createForLead(ctx: RequestContext, params: { leadId: string; scheduledAt: string }, now: Date = new Date()) {
    assertCan(ctx, "site-visits:manage");
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: params.leadId, scope: await leadScopeFor(ctx) });
    if (!lead) throw new NotFoundError(`Lead ${params.leadId} not found`);
    return siteVisitsServiceImpl.bookSiteVisit(
      ctx,
      { leadId: lead.id, projectId: lead.projectId, isoDateTime: params.scheduledAt, source: "dashboard" },
      now,
    );
  },

  /** Moves an upcoming visit. Cancelled and past visits cannot be moved (ConflictError). Out of scope = not found. */
  async reschedule(ctx: RequestContext, params: { id: string; scheduledAt: string }, now: Date = new Date()) {
    assertCan(ctx, "site-visits:manage");
    const visit = await siteVisitsServiceImpl.getById(ctx, { id: params.id });
    if (!visit) throw new NotFoundError(`Site visit ${params.id} not found`);
    const scheduledAt = new Date(params.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) throw new ValidationError("Invalid date/time");
    assertBookableTime(scheduledAt, now);
    const updated = await siteVisitsRepository.reschedule({ organizationId: ctx.organizationId, id: visit.id, scheduledAt, now });
    if (!updated) throw new ConflictError(transitionRefusal(visit, now));
    await auditService.record(ctx, {
      action: "site_visit.rescheduled",
      entityType: "site_visit",
      entityId: visit.id,
      metadata: { leadId: visit.leadId, from: visit.scheduledAt, to: scheduledAt },
    });
    return updated;
  },

  /** Cancels an upcoming visit. The lead's status is left as it is: the team decides what happens next. */
  async cancel(ctx: RequestContext, params: { id: string }, now: Date = new Date()) {
    assertCan(ctx, "site-visits:manage");
    const visit = await siteVisitsServiceImpl.getById(ctx, { id: params.id });
    if (!visit) throw new NotFoundError(`Site visit ${params.id} not found`);
    const cancelled = await siteVisitsRepository.cancel({ organizationId: ctx.organizationId, id: visit.id, now });
    if (!cancelled) throw new ConflictError(transitionRefusal(visit, now));
    await auditService.record(ctx, {
      action: "site_visit.cancelled",
      entityType: "site_visit",
      entityId: visit.id,
      metadata: { leadId: visit.leadId, scheduledAt: visit.scheduledAt },
    });
    return cancelled;
  },

  /** One page of visits with lead and project names, limited to leads in the caller's scope. */
  async listPage(
    ctx: RequestContext,
    params: { view: SiteVisitView; limit: number; offset: number; leadId?: string },
    now: Date = new Date(),
  ) {
    assertCan(ctx, "site-visits:read");
    return siteVisitsRepository.listDetailed({
      organizationId: ctx.organizationId,
      scope: await leadScopeFor(ctx),
      now,
      ...params,
    });
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
