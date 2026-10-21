import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { calls, followUps, leads } from "../schema.js";
import { scopeCondition } from "./leads.repository.js";
import type { LeadScope } from "../../auth/scope.js";

export const FOLLOW_UP_KINDS = ["human_requested", "callback", "info_requested", "do_not_call", "preference"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

/** Every method requires an organizationId and filters by it. */
export const followUpsRepository = {
  async create(params: { organizationId: string; leadId: string | null; callId: string | null; kind: FollowUpKind; note: string | null; dueAt: Date | null }) {
    const rows = await db.insert(followUps).values(params).returning();
    return rows[0];
  },

  /** The still-open follow-up of this kind that this call already recorded (the model may ask twice). */
  async findOpenForCall(params: { organizationId: string; callId: string; kind: FollowUpKind }) {
    const rows = await db
      .select()
      .from(followUps)
      .where(
        and(
          eq(followUps.organizationId, params.organizationId),
          eq(followUps.callId, params.callId),
          eq(followUps.kind, params.kind),
          eq(followUps.status, "open"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async update(params: { organizationId: string; id: string; note: string | null; dueAt: Date | null }) {
    const rows = await db
      .update(followUps)
      .set({ note: params.note, dueAt: params.dueAt })
      .where(and(eq(followUps.organizationId, params.organizationId), eq(followUps.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  /** All follow-ups of one lead, open ones first, newest first within each. */
  async listByLead(params: { organizationId: string; leadId: string }) {
    return db
      .select()
      .from(followUps)
      .where(and(eq(followUps.organizationId, params.organizationId), eq(followUps.leadId, params.leadId)))
      .orderBy(asc(followUps.status), desc(followUps.createdAt));
  },

  /**
   * Open follow-ups the caller may see, oldest first (the queue to work through), with who to ring. Follow-ups of a call
   * that had no lead carry the call's own number and are visible only to a caller who sees every lead.
   */
  async listOpen(params: { organizationId: string; scope?: LeadScope; limit?: number }) {
    return db
      .select({
        id: followUps.id,
        leadId: followUps.leadId,
        callId: followUps.callId,
        kind: followUps.kind,
        note: followUps.note,
        dueAt: followUps.dueAt,
        status: followUps.status,
        createdAt: followUps.createdAt,
        leadName: leads.name,
        leadPhone: leads.phone,
        callerName: calls.counterpartyName,
        callerPhone: calls.counterpartyNumber,
      })
      .from(followUps)
      .leftJoin(leads, and(eq(leads.organizationId, followUps.organizationId), eq(leads.id, followUps.leadId)))
      .leftJoin(calls, and(eq(calls.organizationId, followUps.organizationId), eq(calls.id, followUps.callId)))
      .where(and(eq(followUps.organizationId, params.organizationId), eq(followUps.status, "open"), scopeCondition(params.scope)))
      .orderBy(asc(followUps.createdAt))
      .limit(params.limit ?? 200);
  },

  /**
   * What callers asked for that the agent could not answer, for one project: the info_requested notes of its leads, newest
   * first. This is the list a client works from to fill the gaps in the project's knowledge.
   */
  async listInfoRequestsForProject(params: { organizationId: string; projectId: string; limit?: number }) {
    return db
      .select({ id: followUps.id, note: followUps.note, status: followUps.status, createdAt: followUps.createdAt, leadId: followUps.leadId, leadName: leads.name })
      .from(followUps)
      .innerJoin(leads, and(eq(leads.organizationId, followUps.organizationId), eq(leads.id, followUps.leadId)))
      .where(
        and(
          eq(followUps.organizationId, params.organizationId),
          eq(followUps.kind, "info_requested"),
          eq(leads.projectId, params.projectId),
        ),
      )
      .orderBy(desc(followUps.createdAt))
      .limit(params.limit ?? 100);
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(followUps)
      .where(and(eq(followUps.organizationId, params.organizationId), eq(followUps.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async markDone(params: { organizationId: string; id: string }) {
    const rows = await db
      .update(followUps)
      .set({ status: "done", resolvedAt: new Date() })
      .where(and(eq(followUps.organizationId, params.organizationId), eq(followUps.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },
};
