import { and, eq, desc, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { systemLookups } from "../system-lookups.js";
import { runInTenant } from "../tenant-context.js";
import { agents, calls, conversations, usageLedger, type callStatusEnum, type callTypeEnum } from "../schema.js";

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

/** A call that is still using a line: not yet over. */
const ACTIVE_STATUSES: CallStatus[] = ["initiating", "ringing", "in_progress"];

export interface NewCallParams {
  organizationId: string;
  agentId: string;
  status: CallStatus;
  callType?: CallType;
  leadId?: string | null;
  providerCallId?: string | null;
  counterpartyNumber?: string | null;
  counterpartyName?: string | null;
  initiatedByUserId?: string | null;
}

function newCallValues(params: NewCallParams) {
  return {
    organizationId: params.organizationId,
    agentId: params.agentId,
    leadId: params.leadId ?? null,
    callType: params.callType ?? "outbound",
    status: params.status,
    providerCallId: params.providerCallId ?? null,
    counterpartyNumber: params.counterpartyNumber ?? null,
    counterpartyName: params.counterpartyName ?? null,
    initiatedByUserId: params.initiatedByUserId ?? null,
  };
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
    const organizationId = await systemLookups.callOrgById(params.id);
    if (!organizationId) return null;
    return runInTenant({ organizationId }, async () => {
      const rows = await db.select().from(calls).where(and(eq(calls.organizationId, organizationId), eq(calls.id, params.id))).limit(1);
      return rows[0] ?? null;
    });
  },

  /** SYSTEM ONLY: provider call ids are globally unique (unique index), so this is unambiguous. */
  async findByProviderCallIdAnyOrg(params: { providerCallId: string }) {
    const organizationId = await systemLookups.callOrgByProviderCallId(params.providerCallId);
    if (!organizationId) return null;
    return runInTenant({ organizationId }, async () => {
      const rows = await db
        .select()
        .from(calls)
        .where(and(eq(calls.organizationId, organizationId), eq(calls.providerCallId, params.providerCallId)))
        .limit(1);
      return rows[0] ?? null;
    });
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

  async create(params: NewCallParams) {
    const rows = await db.insert(calls).values(newCallValues(params)).returning();
    return rows[0];
  },

  /**
   * Creates a call only if the organization is under its limits, atomically: a per-organization advisory lock
   * serializes the count-then-insert, so concurrent requests (even on different API instances) cannot both slip
   * under a limit. A limit of 0 means unlimited. Returns which limit blocked it instead of inserting.
   */
  async createWithinLimits(
    params: NewCallParams & {
      maxConcurrent: number;
      maxPerDay: number;
      now?: Date;
      /**
       * Included-minute admission (billing). Evaluated under the SAME advisory lock as the concurrency count, so N
       * parallel admissions are serialised: each sees every earlier admitted call as in flight. A call is refused when
       *   usedSeconds(non-superseded ledger rows in [periodStart, periodEnd)) + inFlightCalls * reserveSecondsPerCall
       *   >= includedSeconds.
       * See docs/billing/README.md "Included-minute admission" for the permitted overshoot.
       */
      minutes?: { periodStart: Date; periodEnd: Date; includedSeconds: number; reserveSecondsPerCall: number };
    },
  ): Promise<{ call: typeof calls.$inferSelect } | { blocked: "concurrent" | "daily" | "minutes"; limit: number }> {
    const now = params.now ?? new Date();
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${params.organizationId}::text, 0))`);
      if (params.maxConcurrent > 0 || params.minutes) {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(calls)
          .where(and(eq(calls.organizationId, params.organizationId), inArray(calls.status, ACTIVE_STATUSES)));
        if (params.maxConcurrent > 0 && row.n >= params.maxConcurrent) {
          return { blocked: "concurrent" as const, limit: params.maxConcurrent };
        }
        if (params.minutes) {
          const m = params.minutes;
          const [u] = await tx
            .select({ s: sql<number>`coalesce(sum(${usageLedger.billableSeconds}), 0)::int` })
            .from(usageLedger)
            .where(
              and(
                eq(usageLedger.organizationId, params.organizationId),
                sql`${usageLedger.state} <> 'superseded'`,
                gte(usageLedger.occurredAt, m.periodStart),
                lt(usageLedger.occurredAt, m.periodEnd),
              ),
            );
          if (u.s + row.n * m.reserveSecondsPerCall >= m.includedSeconds) {
            return { blocked: "minutes" as const, limit: Math.floor(m.includedSeconds / 60) };
          }
        }
      }
      if (params.maxPerDay > 0) {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(calls)
          .where(and(eq(calls.organizationId, params.organizationId), gte(calls.createdAt, new Date(now.getTime() - 24 * 3600_000))));
        if (row.n >= params.maxPerDay) return { blocked: "daily" as const, limit: params.maxPerDay };
      }
      const rows = await tx.insert(calls).values(newCallValues(params)).returning();
      return { call: rows[0] };
    });
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
    const refs = await systemLookups.staleCallRefs(params);
    const byOrg = new Map<string, string[]>();
    for (const ref of refs) byOrg.set(ref.organizationId, [...(byOrg.get(ref.organizationId) ?? []), ref.id]);
    const found: Array<typeof calls.$inferSelect> = [];
    for (const [organizationId, ids] of byOrg) {
      const rows = await runInTenant({ organizationId }, async () =>
        await db.select().from(calls).where(and(eq(calls.organizationId, organizationId), inArray(calls.id, ids))),
      );
      found.push(...rows);
    }
    return found;
  },
};
