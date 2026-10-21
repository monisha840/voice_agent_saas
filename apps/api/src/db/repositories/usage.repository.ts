import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../client.js";
import { usageEvents } from "../schema.js";

/** Test calls (launched from the Test page) are recorded for traceability but never counted in usage totals. */
const notTestCall = sql`coalesce(${usageEvents.metadata}->>'callType', '') <> 'test'`;

type UsageType = (typeof usageEvents.$inferSelect)["type"];

/** Append-only. Every read is organization-scoped; inserts are idempotent via dedupeKey. */
export const usageRepository = {
  /** Returns the row, or null if an event with this dedupeKey already exists (idempotent no-op). */
  async record(row: {
    organizationId: string;
    type: UsageType;
    quantity?: number;
    callId?: string | null;
    dedupeKey: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  }) {
    const rows = await db
      .insert(usageEvents)
      .values({
        organizationId: row.organizationId,
        type: row.type,
        quantity: row.quantity ?? 1,
        callId: row.callId ?? null,
        dedupeKey: row.dedupeKey,
        metadata: row.metadata ?? {},
        occurredAt: row.occurredAt ?? new Date(),
      })
      .onConflictDoNothing({ target: [usageEvents.organizationId, usageEvents.dedupeKey] })
      .returning();
    return rows[0] ?? null;
  },

  /** Totals per type within [from, to). */
  async summarize(params: { organizationId: string; from: Date; to: Date }) {
    return db
      .select({ type: usageEvents.type, total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`, events: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organizationId, params.organizationId),
          gte(usageEvents.occurredAt, params.from),
          lt(usageEvents.occurredAt, params.to),
          notTestCall,
        ),
      )
      .groupBy(usageEvents.type);
  },

  /** Per-UTC-day totals per type within [from, to). Bucketing happens in SQL. */
  async dailyByType(params: { organizationId: string; from: Date; to: Date }) {
    const day = sql<string>`to_char(date_trunc('day', ${usageEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    return db
      .select({ day, type: usageEvents.type, total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.organizationId, params.organizationId),
          gte(usageEvents.occurredAt, params.from),
          lt(usageEvents.occurredAt, params.to),
          notTestCall,
        ),
      )
      .groupBy(day, usageEvents.type)
      .orderBy(day);
  },
};
