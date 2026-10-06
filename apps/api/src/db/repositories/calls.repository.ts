import { and, eq, desc, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { agents, calls, conversations, type callStatusEnum, type callTypeEnum } from "../schema.js";

type CallStatus = (typeof callStatusEnum.enumValues)[number];
export type CallType = (typeof callTypeEnum.enumValues)[number];

/**
 * Row-level visibility for a restricted viewer, as a WHERE fragment over the `calls` table only (undefined = no
 * restriction). The core never decides what a module-owned association means: the Sales module supplies its own
 * fragment (lead scoping, via a correlated organization-bound subquery) through the call hooks.
 * It is always ANDed with the organization filter, so it can only narrow the result.
 */
export type CallVisibilityCondition = SQL | undefined;

/** Core default when no module speaks for a viewer: calls they started, plus (managers) calls with no association. */
export function ownCallsVisibility(params: { userId: string; includeUnassociated: boolean }): SQL {
  const own = eq(calls.initiatedByUserId, params.userId);
  return (params.includeUnassociated ? or(own, isNull(calls.leadId)) : own) as SQL;
}

/**
 * Every method requires an organizationId and filters by it — EXCEPT the
 * explicitly named `...AnyOrg` methods. Those exist only for system flows
 * that start from a provider-supplied identifier with no logged-in user
 * (the Exotel webhook/socket resolving a call by its provider id, the
 * stale-call reaper). They return the row including its organizationId, from
 * which the caller derives a system context. Never call them from a
 * user-facing route.
 */
export const callsRepository = {
  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.organizationId, params.organizationId), eq(calls.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** A call the caller is allowed to see (visibility applied in SQL; out-of-scope behaves like missing). */
  async findByIdVisible(params: { organizationId: string; id: string; visibility?: CallVisibilityCondition }) {
    const rows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.organizationId, params.organizationId), eq(calls.id, params.id), params.visibility))
      .limit(1);
    return rows[0] ?? null;
  },

  /** SYSTEM ONLY: find a call by id without knowing its organization yet. */
  async findByIdAnyOrg(params: { id: string }) {
    const rows = await db.select().from(calls).where(eq(calls.id, params.id)).limit(1);
    return rows[0] ?? null;
  },

  /** SYSTEM ONLY: provider call ids are globally unique (unique index), so this is unambiguous. */
  async findByProviderCallIdAnyOrg(params: { providerCallId: string }) {
    const rows = await db
      .select()
      .from(calls)
      .where(eq(calls.providerCallId, params.providerCallId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Newest-first page of an organization's calls. Needs no lead or other module data; modules add their own
   * fields afterwards through the call hooks. Fetch limit + 1 to detect another page.
   */
  async list(params: {
    organizationId: string;
    visibility?: CallVisibilityCondition;
    status?: CallStatus;
    agentId?: string;
    callType?: CallType;
    before?: Date;
    limit: number;
  }) {
    return db
      .select({
        id: calls.id,
        agentId: calls.agentId,
        agentName: agents.name,
        callType: calls.callType,
        leadId: calls.leadId,
        counterpartyNumber: calls.counterpartyNumber,
        counterpartyName: calls.counterpartyName,
        status: calls.status,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        createdAt: calls.createdAt,
        summary: conversations.summary,
      })
      .from(calls)
      .leftJoin(agents, and(eq(agents.organizationId, calls.organizationId), eq(agents.id, calls.agentId)))
      .leftJoin(conversations, and(eq(conversations.organizationId, calls.organizationId), eq(conversations.callId, calls.id)))
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          params.visibility,
          params.status ? eq(calls.status, params.status) : undefined,
          params.agentId ? eq(calls.agentId, params.agentId) : undefined,
          params.callType ? eq(calls.callType, params.callType) : undefined,
          params.before ? lt(calls.createdAt, params.before) : undefined,
        ),
      )
      .orderBy(desc(calls.createdAt), desc(calls.id))
      .limit(params.limit);
  },

  async listByLead(params: { organizationId: string; leadId: string }) {
    return db
      .select()
      .from(calls)
      .where(and(eq(calls.organizationId, params.organizationId), eq(calls.leadId, params.leadId)))
      .orderBy(desc(calls.createdAt));
  },

  async create(params: {
    organizationId: string;
    agentId: string;
    status: CallStatus;
    callType?: CallType;
    leadId?: string | null;
    providerCallId?: string | null;
    counterpartyNumber?: string | null;
    counterpartyName?: string | null;
    initiatedByUserId?: string | null;
  }) {
    const rows = await db
      .insert(calls)
      .values({
        organizationId: params.organizationId,
        agentId: params.agentId,
        leadId: params.leadId ?? null,
        callType: params.callType ?? "outbound",
        status: params.status,
        providerCallId: params.providerCallId ?? null,
        counterpartyNumber: params.counterpartyNumber ?? null,
        counterpartyName: params.counterpartyName ?? null,
        initiatedByUserId: params.initiatedByUserId ?? null,
      })
      .returning();
    return rows[0];
  },

  async setProviderCallId(params: { organizationId: string; id: string; providerCallId: string }) {
    const rows = await db
      .update(calls)
      .set({ providerCallId: params.providerCallId })
      .where(and(eq(calls.organizationId, params.organizationId), eq(calls.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  async updateStatus(params: {
    organizationId: string;
    id: string;
    status: CallStatus;
    startedAt?: Date;
    endedAt?: Date;
    recordingUrl?: string;
  }) {
    const rows = await db
      .update(calls)
      .set({
        status: params.status,
        ...(params.startedAt ? { startedAt: params.startedAt } : {}),
        ...(params.endedAt ? { endedAt: params.endedAt } : {}),
        ...(params.recordingUrl ? { recordingUrl: params.recordingUrl } : {}),
      })
      .where(and(eq(calls.organizationId, params.organizationId), eq(calls.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Atomically moves a call to a terminal status ONLY if it is not
   * already terminal. Returns null when the call was already completed/
   * failed, so duplicate provider callbacks are detected race-free.
   */
  async transitionToTerminal(params: {
    organizationId: string;
    id: string;
    status: CallStatus;
    endedAt: Date;
    recordingUrl?: string;
  }) {
    const rows = await db
      .update(calls)
      .set({
        status: params.status,
        endedAt: params.endedAt,
        ...(params.recordingUrl ? { recordingUrl: params.recordingUrl } : {}),
      })
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          eq(calls.id, params.id),
          notInArray(calls.status, ["completed", "failed"]),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * SYSTEM ONLY (reaper): calls in ANY organization that should have ended
   * by now — never-answered calls older than `pendingBefore`, and answered
   * calls running longer than `inProgressBefore`.
   */
  async listStaleAnyOrg(params: { pendingBefore: Date; inProgressBefore: Date }) {
    return db
      .select()
      .from(calls)
      .where(
        or(
          and(inArray(calls.status, ["initiating", "ringing"]), lt(calls.createdAt, params.pendingBefore)),
          and(
            eq(calls.status, "in_progress"),
            sql`coalesce(${calls.startedAt}, ${calls.createdAt}) < ${params.inProgressBefore.toISOString()}::timestamptz`,
          ),
        ),
      );
  },
};
