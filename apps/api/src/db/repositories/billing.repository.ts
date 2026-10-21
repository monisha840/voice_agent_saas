import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { agents, billingEvents, calls, invitations, memberships, plans, subscriptions, usageLedger } from "../schema.js";

export type PlanRow = typeof plans.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type LedgerRow = typeof usageLedger.$inferSelect;
export type NewLedgerRow = typeof usageLedger.$inferInsert;

/** The plan catalog: global reference data, read-only for the runtime role (no organization column). */
export const plansRepository = {
  async list() {
    return db.select().from(plans).where(eq(plans.isActive, true)).orderBy(asc(plans.sortOrder));
  },
  async get(params: { key: string }) {
    const rows = await db.select().from(plans).where(eq(plans.key, params.key)).limit(1);
    return rows[0] ?? null;
  },
};

export const subscriptionsRepository = {
  async find(params: { organizationId: string }) {
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, params.organizationId)).limit(1);
    return rows[0] ?? null;
  },

  /** Seats in use: active agents, and members plus pending invitations (what the seat-cap triggers count). */
  async seatCounts(params: { organizationId: string }) {
    const org = params.organizationId;
    const [a] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.organizationId, org), eq(agents.status, "active")));
    const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.organizationId, org));
    const [i] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, org),
          sql`${invitations.acceptedAt} is null and ${invitations.revokedAt} is null and ${invitations.expiresAt} > now()`,
        ),
      );
    return { agents: a.n, teamMembers: m.n + i.n };
  },

  /** Idempotent: returns null when the organization already has a subscription (unique per organization). */
  async insert(params: { organizationId: string; values: Omit<typeof subscriptions.$inferInsert, "organizationId" | "id"> }) {
    const rows = await db
      .insert(subscriptions)
      .values({ ...params.values, organizationId: params.organizationId })
      .onConflictDoNothing({ target: subscriptions.organizationId })
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Optimistic update: applies `set` only if the row still has the `updatedAt` the caller read. Returns null when
   * another writer got there first (the caller re-reads and retries or reports a conflict).
   */
  async updateIfUnchanged(params: {
    organizationId: string;
    expectedUpdatedAt: Date;
    set: Partial<Omit<typeof subscriptions.$inferInsert, "id" | "organizationId" | "createdAt">>;
  }) {
    const rows = await db
      .update(subscriptions)
      .set({ ...params.set, updatedAt: new Date(Math.max(Date.now(), params.expectedUpdatedAt.getTime() + 1)) })
      .where(
        and(eq(subscriptions.organizationId, params.organizationId), sameInstant(params.expectedUpdatedAt)),
      )
      .returning();
    return rows[0] ?? null;
  },
};

/**
 * updated_at compared at millisecond precision: PostgreSQL stores microseconds, a JS Date holds milliseconds, so a plain
 * equality would never match a row written by now(). Writers here always store millisecond-precision values.
 */
const sameInstant = (expected: Date) => sql`date_trunc('milliseconds', ${subscriptions.updatedAt}) = ${expected.toISOString()}::timestamptz`;

const CALL_TERMINAL = ["completed", "failed"] as const;

export const usageLedgerRepository = {
  /** Append-only and idempotent on (organizationId, idempotencyKey). Returns null for a duplicate. */
  async insertIfAbsent(params: { organizationId: string; row: Omit<NewLedgerRow, "organizationId" | "id"> }) {
    const rows = await db
      .insert(usageLedger)
      .values({ ...params.row, organizationId: params.organizationId })
      .onConflictDoNothing({ target: [usageLedger.organizationId, usageLedger.idempotencyKey] })
      .returning();
    return rows[0] ?? null;
  },

  async findByKey(params: { organizationId: string; idempotencyKey: string }) {
    const rows = await db
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.organizationId, params.organizationId), eq(usageLedger.idempotencyKey, params.idempotencyKey)))
      .limit(1);
    return rows[0] ?? null;
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.organizationId, params.organizationId), eq(usageLedger.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Inserts `row` and marks `supersedesId` superseded in ONE transaction. Returns null (and writes nothing) when the
   * original is already superseded by someone else, or the correction key already exists.
   */
  async supersede(params: { organizationId: string; supersedesId: string; row: Omit<NewLedgerRow, "organizationId" | "id" | "supersedesId"> }) {
    const ROLLBACK = Symbol("rollback");
    try {
      return await db.transaction(async (tx) => {
        const marked = await tx
          .update(usageLedger)
          .set({ state: "superseded" })
          .where(
            and(
              eq(usageLedger.organizationId, params.organizationId),
              eq(usageLedger.id, params.supersedesId),
              ne(usageLedger.state, "superseded"),
            ),
          )
          .returning({ id: usageLedger.id });
        if (marked.length === 0) return null;
        const inserted = await tx
          .insert(usageLedger)
          .values({ ...params.row, organizationId: params.organizationId, supersedesId: params.supersedesId })
          .onConflictDoNothing({ target: [usageLedger.organizationId, usageLedger.idempotencyKey] })
          .returning();
        if (inserted.length === 0) throw ROLLBACK; // duplicate correction key: undo the state change
        return inserted[0];
      });
    } catch (err) {
      if (err === ROLLBACK) return null;
      throw err;
    }
  },

  /** Sum of the effective (non-superseded) billable usage whose occurrence falls in [from, to). */
  async totals(params: { organizationId: string; from: Date; to: Date }) {
    const [row] = await db
      .select({
        billableSeconds: sql<number>`coalesce(sum(${usageLedger.billableSeconds}), 0)::int`,
        billableMinutes: sql<number>`coalesce(sum(${usageLedger.billableMinutes}), 0)::int`,
        entries: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${usageLedger.state} = 'pending')::int`,
      })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.organizationId, params.organizationId),
          ne(usageLedger.state, "superseded"),
          gte(usageLedger.occurredAt, params.from),
          lt(usageLedger.occurredAt, params.to),
        ),
      );
    return row;
  },

  /** Newest first, keyset-paginated on (occurredAt, id). Includes superseded rows when `includeSuperseded`. */
  async list(params: {
    organizationId: string;
    limit: number;
    before?: { occurredAt: Date; id: string };
    from?: Date;
    to?: Date;
    includeSuperseded?: boolean;
  }) {
    const conds = [eq(usageLedger.organizationId, params.organizationId)];
    if (!params.includeSuperseded) conds.push(ne(usageLedger.state, "superseded"));
    if (params.from) conds.push(gte(usageLedger.occurredAt, params.from));
    if (params.to) conds.push(lt(usageLedger.occurredAt, params.to));
    if (params.before) {
      conds.push(
        or(
          lt(usageLedger.occurredAt, params.before.occurredAt),
          and(eq(usageLedger.occurredAt, params.before.occurredAt), lt(usageLedger.id, params.before.id)),
        )!,
      );
    }
    return db
      .select()
      .from(usageLedger)
      .where(and(...conds))
      .orderBy(desc(usageLedger.occurredAt), desc(usageLedger.id))
      .limit(params.limit);
  },

  /** Terminal calls of the organization that have no ledger row yet (oldest first, bounded). */
  async findUnmeteredCalls(params: { organizationId: string; limit: number; since?: Date }) {
    const key = sql`'call:' || ${calls.id}::text`;
    return db
      .select({
        id: calls.id,
        providerCallId: calls.providerCallId,
        status: calls.status,
        callType: calls.callType,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        createdAt: calls.createdAt,
      })
      .from(calls)
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          inArray(calls.status, [...CALL_TERMINAL]),
          params.since ? gte(calls.createdAt, params.since) : undefined,
          sql`not exists (select 1 from ${usageLedger} l where l.organization_id = ${calls.organizationId} and l.idempotency_key = ${key})`,
        ),
      )
      .orderBy(asc(calls.createdAt))
      .limit(params.limit);
  },

  /** Pending rows whose call has since gained an end time (out-of-order delivery): candidates to finalize. */
  async findPendingWithCalls(params: { organizationId: string; limit: number }) {
    return db
      .select({
        ledgerId: usageLedger.id,
        callId: calls.id,
        status: calls.status,
        callType: calls.callType,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
      })
      .from(usageLedger)
      .innerJoin(calls, and(eq(calls.organizationId, usageLedger.organizationId), eq(calls.id, usageLedger.callId)))
      .where(and(eq(usageLedger.organizationId, params.organizationId), eq(usageLedger.state, "pending")))
      .limit(params.limit);
  },
};

export const billingEventsRepository = {
  /**
   * Records a verified provider event and (optionally) applies its subscription change in ONE transaction, so an event
   * can never be marked handled without its effect, nor applied twice. Result: "applied" | "duplicate" | "conflict"
   * (the subscription changed underneath us; nothing was written, the provider will redeliver).
   */
  async recordAndApply(params: {
    organizationId: string;
    event: { provider: string; providerEventId: string; eventType: string; outcome: "applied" | "ignored"; payloadDigest: string };
    subscription?: { expectedUpdatedAt: Date; set: Partial<Omit<typeof subscriptions.$inferInsert, "id" | "organizationId" | "createdAt">> };
  }): Promise<"applied" | "duplicate" | "conflict"> {
    const ROLLBACK = Symbol("rollback");
    try {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(billingEvents)
          .values({ organizationId: params.organizationId, ...params.event })
          .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.providerEventId] })
          .returning({ id: billingEvents.id });
        if (inserted.length === 0) return "duplicate" as const;
        if (params.subscription) {
          const updated = await tx
            .update(subscriptions)
            .set({
              ...params.subscription.set,
              updatedAt: new Date(Math.max(Date.now(), params.subscription.expectedUpdatedAt.getTime() + 1)),
            })
            .where(
              and(
                eq(subscriptions.organizationId, params.organizationId),
                sameInstant(params.subscription.expectedUpdatedAt),
              ),
            )
            .returning({ id: subscriptions.id });
          if (updated.length === 0) throw ROLLBACK;
        }
        return "applied" as const;
      });
    } catch (err) {
      if (err === ROLLBACK) return "conflict";
      throw err;
    }
  },

  /** Returns null when this provider event was already handled (idempotent). */
  async insertIfNew(params: {
    organizationId: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    outcome: string;
    payloadDigest: string;
  }) {
    const rows = await db
      .insert(billingEvents)
      .values(params)
      .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.providerEventId] })
      .returning();
    return rows[0] ?? null;
  },
};
