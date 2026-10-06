/**
 * Usage ledger foundation (NO billing logic). Events are append-only and
 * idempotent: each carries a dedupeKey, so a call finalized twice or a retried
 * webhook can never double-count.
 *
 *   call          1 per finalized call              dedupeKey call:<callId>
 *   call_seconds  conversation seconds              dedupeKey call_seconds:<callId>
 *   ai_turn       number of AI replies in the call  dedupeKey ai_turn:<callId>
 *   site_visit    1 per booked visit                dedupeKey site_visit:<visitId>
 */
import { usageRepository } from "../../db/repositories/usage.repository.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { conversationsRepository, type TranscriptTurn } from "../../db/repositories/conversations.repository.js";
import type { RequestContext } from "../../auth/context.js";
import { assertCan } from "../../auth/access.js";
import { logger } from "../../shared/logger.js";
import { ValidationError } from "../../shared/errors.js";

export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

export interface UsageRange {
  from: Date;
  to: Date;
}

/**
 * Resolves and validates the requested window. Defaults to the last 30 days.
 * A date-only `to` (YYYY-MM-DD) is inclusive of that whole UTC day; the window
 * is [from, to) internally.
 */
export function resolveRange(input: { from?: string; to?: string }, now = new Date()): UsageRange {
  const parse = (label: string, value: string): Date => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new ValidationError(`Invalid request - ${label}: must be an ISO date`);
    return new Date(ms);
  };
  let to = now;
  if (input.to) {
    to = parse("to", input.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.to)) to = new Date(to.getTime() + DAY_MS);
  }
  const from = input.from ? parse("from", input.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from >= to) throw new ValidationError("Invalid request - from: must be before to");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ValidationError(`Invalid request - range: at most ${MAX_RANGE_DAYS} days`);
  }
  return { from, to };
}

type Totals = { calls: number; callSeconds: number; aiTurns: number; siteVisits: number };
const TOTAL_KEY = { call: "calls", call_seconds: "callSeconds", ai_turn: "aiTurns", site_visit: "siteVisits" } as const;

export const usageService = {
  /** Records one booked site visit. Idempotent; never throws (usage must not fail the business action). */
  async recordSiteVisit(ctx: RequestContext, visit: { id: string; leadId: string; projectId: string }) {
    try {
      await usageRepository.record({
        organizationId: ctx.organizationId,
        type: "site_visit",
        quantity: 1,
        dedupeKey: `site_visit:${visit.id}`,
        metadata: { siteVisitId: visit.id, leadId: visit.leadId, projectId: visit.projectId },
      });
    } catch (err) {
      logger.error("usage: failed to record site visit", { error: err instanceof Error ? err.message : String(err) });
    }
  },

  /**
   * Records call, call_seconds (only when both timestamps exist) and ai_turn
   * for a finalized call. Idempotent via dedupeKey; never throws.
   */
  async recordCallUsage(ctx: RequestContext, callId: string) {
    try {
      const org = ctx.organizationId;
      const call = await callsRepository.findById({ organizationId: org, id: callId });
      if (!call) return;
      const occurredAt = call.endedAt ?? new Date();
      // callType/agentId travel with every event; the usage summary leaves test calls out of the totals.
      const base = { organizationId: org, callId, occurredAt, metadata: { callType: call.callType, agentId: call.agentId } };
      await usageRepository.record({ ...base, type: "call", quantity: 1, dedupeKey: `call:${callId}` });
      if (call.startedAt && call.endedAt) {
        const seconds = Math.max(0, Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000));
        await usageRepository.record({ ...base, type: "call_seconds", quantity: seconds, dedupeKey: `call_seconds:${callId}` });
      }
      const conversation = await conversationsRepository.findByCallId({ organizationId: org, callId });
      const transcript = (conversation?.transcript as TranscriptTurn[] | null) ?? [];
      const aiTurns = transcript.filter((t) => t.speaker === "ai").length;
      await usageRepository.record({ ...base, type: "ai_turn", quantity: aiTurns, dedupeKey: `ai_turn:${callId}` });
    } catch (err) {
      logger.error("usage: failed to record call usage", { callId, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async summary(ctx: RequestContext, input: { from?: string; to?: string }) {
    assertCan(ctx, "usage:read");
    const range = resolveRange(input);
    const rows = await usageRepository.summarize({ organizationId: ctx.organizationId, ...range });
    const totals: Totals = { calls: 0, callSeconds: 0, aiTurns: 0, siteVisits: 0 };
    for (const r of rows) totals[TOTAL_KEY[r.type]] = r.total;
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totals,
      byType: rows.map((r) => ({ type: r.type, total: r.total, events: r.events })),
    };
  },

  /** One bucket per UTC day in the range (days with no usage are zero-filled). */
  async daily(ctx: RequestContext, input: { from?: string; to?: string }) {
    assertCan(ctx, "usage:read");
    const range = resolveRange(input);
    const rows = await usageRepository.dailyByType({ organizationId: ctx.organizationId, ...range });
    const buckets = new Map<string, Totals>();
    const startDay = Math.floor(range.from.getTime() / DAY_MS) * DAY_MS;
    for (let t = startDay; t < range.to.getTime(); t += DAY_MS) {
      buckets.set(new Date(t).toISOString().slice(0, 10), { calls: 0, callSeconds: 0, aiTurns: 0, siteVisits: 0 });
    }
    for (const r of rows) {
      const bucket = buckets.get(r.day);
      if (bucket) bucket[TOTAL_KEY[r.type]] = r.total;
    }
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      data: [...buckets].map(([date, totals]) => ({ date, ...totals })),
    };
  },
};
