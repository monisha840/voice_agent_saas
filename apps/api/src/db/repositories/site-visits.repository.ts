import { and, asc, desc, eq, gt, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { leads, projects, siteVisits } from "../schema.js";
import type { LeadScope } from "../../auth/scope.js";
import { scopeCondition } from "./leads.repository.js";

/**
 * upcoming = booked and still ahead; past = booked and its time has passed (attendance is not recorded);
 * cancelled = cancelled at any time.
 */
export type SiteVisitView = "upcoming" | "past" | "cancelled" | "all";

function viewCondition(view: SiteVisitView, now: Date): SQL | undefined {
  switch (view) {
    case "upcoming":
      return and(eq(siteVisits.status, "booked"), gt(siteVisits.scheduledAt, now));
    case "past":
      return and(eq(siteVisits.status, "booked"), lte(siteVisits.scheduledAt, now));
    case "cancelled":
      return eq(siteVisits.status, "cancelled");
    case "all":
      return undefined;
  }
}

/** Raised inside the booking transaction when the lead already has an upcoming visit. */
export class ActiveVisitExistsError extends Error {
  constructor(readonly existing: { id: string; scheduledAt: Date }) {
    super("lead already has an upcoming site visit");
  }
}

/** Every method requires an organizationId and filters by it. */
export const siteVisitsRepository = {
  async list(params: { organizationId: string }) {
    return db
      .select()
      .from(siteVisits)
      .where(eq(siteVisits.organizationId, params.organizationId))
      .orderBy(desc(siteVisits.scheduledAt));
  },

  /**
   * Visits with their lead and project names, restricted to leads in the viewer's scope (a join, not a post-filter),
   * one page at a time. Upcoming visits are listed soonest first, everything else most recent first.
   */
  async listDetailed(params: {
    organizationId: string;
    scope?: LeadScope;
    view: SiteVisitView;
    now: Date;
    limit: number;
    offset: number;
    leadId?: string;
  }) {
    const where = and(
      eq(siteVisits.organizationId, params.organizationId),
      scopeCondition(params.scope),
      viewCondition(params.view, params.now),
      params.leadId ? eq(siteVisits.leadId, params.leadId) : undefined,
    );
    const rows = await db
      .select({
        id: siteVisits.id,
        leadId: siteVisits.leadId,
        projectId: siteVisits.projectId,
        scheduledAt: siteVisits.scheduledAt,
        status: siteVisits.status,
        createdAt: siteVisits.createdAt,
        leadName: leads.name,
        leadPhone: leads.phone,
        leadStatus: leads.status,
        projectName: projects.name,
      })
      .from(siteVisits)
      .innerJoin(leads, and(eq(leads.organizationId, siteVisits.organizationId), eq(leads.id, siteVisits.leadId)))
      .innerJoin(projects, and(eq(projects.organizationId, siteVisits.organizationId), eq(projects.id, siteVisits.projectId)))
      .where(where)
      .orderBy(params.view === "upcoming" ? asc(siteVisits.scheduledAt) : desc(siteVisits.scheduledAt), desc(siteVisits.id))
      .limit(params.limit)
      .offset(params.offset);
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(siteVisits)
      .innerJoin(leads, and(eq(leads.organizationId, siteVisits.organizationId), eq(leads.id, siteVisits.leadId)))
      .where(where);
    return { data: rows, total: count.n };
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(siteVisits)
      .where(and(eq(siteVisits.organizationId, params.organizationId), eq(siteVisits.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByLead(params: { organizationId: string; leadId: string }) {
    return db
      .select()
      .from(siteVisits)
      .where(and(eq(siteVisits.organizationId, params.organizationId), eq(siteVisits.leadId, params.leadId)));
  },

  /**
   * Books a visit unless the lead already has an upcoming one. A per-lead transaction-scoped advisory lock serialises
   * concurrent bookings for the same lead (two clicks, two instances, the agent and a person at once), so the
   * check-then-insert cannot admit a duplicate. Throws ActiveVisitExistsError instead of inserting.
   */
  async createUnlessActive(params: { organizationId: string; leadId: string; projectId: string; scheduledAt: Date; now: Date }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"site_visit:" + params.leadId}, 0))`);
      const [existing] = await tx
        .select({ id: siteVisits.id, scheduledAt: siteVisits.scheduledAt })
        .from(siteVisits)
        .where(
          and(
            eq(siteVisits.organizationId, params.organizationId),
            eq(siteVisits.leadId, params.leadId),
            eq(siteVisits.status, "booked"),
            gt(siteVisits.scheduledAt, params.now),
          ),
        )
        .limit(1);
      if (existing) throw new ActiveVisitExistsError(existing);
      const [visit] = await tx
        .insert(siteVisits)
        .values({
          organizationId: params.organizationId,
          leadId: params.leadId,
          projectId: params.projectId,
          scheduledAt: params.scheduledAt,
          status: "booked",
        })
        .returning();
      return visit;
    });
  },

  async create(params: { organizationId: string; leadId: string; projectId: string; scheduledAt: Date }) {
    const rows = await db
      .insert(siteVisits)
      .values({
        organizationId: params.organizationId,
        leadId: params.leadId,
        projectId: params.projectId,
        scheduledAt: params.scheduledAt,
        status: "booked",
      })
      .returning();
    return rows[0];
  },

  /**
   * Moves an UPCOMING booked visit. The state check is part of the UPDATE, so a visit cancelled (or one whose time
   * passed) in the meantime is not modified: null is returned instead.
   */
  async reschedule(params: { organizationId: string; id: string; scheduledAt: Date; now: Date }) {
    const rows = await db
      .update(siteVisits)
      .set({ scheduledAt: params.scheduledAt })
      .where(
        and(
          eq(siteVisits.organizationId, params.organizationId),
          eq(siteVisits.id, params.id),
          eq(siteVisits.status, "booked"),
          gt(siteVisits.scheduledAt, params.now),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** Cancels an UPCOMING booked visit (same atomic state check as reschedule). */
  async cancel(params: { organizationId: string; id: string; now: Date }) {
    const rows = await db
      .update(siteVisits)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(siteVisits.organizationId, params.organizationId),
          eq(siteVisits.id, params.id),
          eq(siteVisits.status, "booked"),
          gt(siteVisits.scheduledAt, params.now),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
};
