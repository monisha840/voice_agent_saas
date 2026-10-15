/**
 * Usage metering over the persisted call lifecycle.
 *
 * Source of truth: the `calls` row (status, startedAt, endedAt written by the server's own lifecycle). Every function
 * here takes an organizationId that the CALLER derived from a trusted source (a verified RequestContext or a call
 * record) and runs inside that tenant's scope, so row-level security applies to every statement.
 *
 * Idempotency: one ledger row per call, keyed `call:<callId>` (unique per organization). Webhook retries, a call
 * reported by both the provider callback and the media stream, and concurrent reconcilers all converge on that one
 * row; the loser of a race inserts nothing.
 *
 * Out-of-order / incomplete lifecycles:
 *  - a call that is not terminal yet records nothing (it is picked up by the next reconcile once it ends);
 *  - a call that connected but has no end time is recorded `pending` (billable 0, reason "interrupted");
 *  - when the end time later arrives, reconcile writes a final row that SUPERSEDES the pending one (history kept).
 *  - a final row is never silently recomputed; changes are explicit corrections (`correct`).
 */
import { runInTenant } from "../../db/tenant-context.js";
import { usageLedgerRepository, type LedgerRow } from "../../db/repositories/billing.repository.js";
import { getBillingPolicy } from "./billing-policy.js";
import { computeBillable, type BillableUsage, type MeterableCall } from "./metering.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";

export type MeterSource = "call_lifecycle" | "reconciliation" | "mock";

export interface MeterableCallRecord extends MeterableCall {
  id: string;
  providerCallId: string | null;
  createdAt: Date;
}

export type MeterResult =
  | { status: "recorded" | "finalized"; entry: LedgerRow }
  | { status: "duplicate"; entry: LedgerRow }
  | { status: "not_terminal" };

function rowFor(call: MeterableCallRecord, usage: BillableUsage, source: MeterSource, key: string) {
  const occurredAt = call.endedAt ?? call.startedAt ?? call.createdAt;
  return {
    callId: call.id,
    providerCallId: call.providerCallId,
    idempotencyKey: key,
    source,
    entryType: "call" as const,
    state: usage.state,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: usage.durationSeconds,
    billableSeconds: usage.billableSeconds,
    billableMinutes: usage.billableMinutes,
    roundingPolicy: usage.roundingPolicy,
    billableReason: usage.reason,
    outcome: usage.outcome,
    terminationReason: call.status === "failed" ? (call.startedAt ? "failed_after_answer" : "not_answered") : "completed",
    occurredAt,
    metadata: { callType: call.callType },
  };
}

export const meteringEngine = {
  /** Meters one terminal call. Safe to call any number of times, concurrently, in any order. */
  async meterCall(organizationId: string, call: MeterableCallRecord, source: MeterSource): Promise<MeterResult> {
    return runInTenant({ organizationId }, async () => {
      const usage = computeBillable(call, getBillingPolicy());
      if (!usage) return { status: "not_terminal" as const };

      const key = `call:${call.id}`;
      const inserted = await usageLedgerRepository.insertIfAbsent({
        organizationId,
        row: rowFor(call, usage, source, key),
      });
      if (inserted) return { status: "recorded" as const, entry: inserted };

      const existing = await usageLedgerRepository.findByKey({ organizationId, idempotencyKey: key });
      if (!existing) throw new Error("usage ledger: idempotency conflict without a row"); // cannot happen (no deletes)

      if (existing.state === "pending" && usage.state === "final") {
        const finalRow = await usageLedgerRepository.supersede({
          organizationId,
          supersedesId: existing.id,
          row: rowFor(call, usage, source, `call:${call.id}:final`),
        });
        if (finalRow) return { status: "finalized" as const, entry: finalRow };
        const winner = await usageLedgerRepository.findByKey({ organizationId, idempotencyKey: `call:${call.id}:final` });
        return { status: "duplicate" as const, entry: winner ?? existing };
      }
      return { status: "duplicate" as const, entry: existing };
    });
  },

  /**
   * Meters every terminal call of the organization that has no ledger row, and finalizes pending rows whose call has
   * since ended. Bounded per pass; call again to continue.
   */
  async reconcile(organizationId: string, opts: { limit?: number; since?: Date } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    return runInTenant({ organizationId }, async () => {
      let recorded = 0;
      let finalized = 0;
      const unmetered = await usageLedgerRepository.findUnmeteredCalls({ organizationId, limit, since: opts.since });
      for (const call of unmetered) {
        const r = await meteringEngine.meterCall(organizationId, call, "reconciliation");
        if (r.status === "recorded") recorded++;
      }
      const pending = await usageLedgerRepository.findPendingWithCalls({ organizationId, limit });
      for (const p of pending) {
        if (!p.endedAt) continue;
        const r = await meteringEngine.meterCall(
          organizationId,
          { id: p.callId, providerCallId: null, status: p.status, callType: p.callType, startedAt: p.startedAt, endedAt: p.endedAt, createdAt: p.startedAt ?? new Date() },
          "reconciliation",
        );
        if (r.status === "finalized") finalized++;
      }
      return { recorded, finalized, scanned: unmetered.length };
    });
  },

  /**
   * Drains the backlog: repeats `reconcile` until a pass finds nothing left (bounded). Used before quota decisions so a
   * burst of ended calls larger than one batch cannot leave usage under-counted.
   */
  async reconcileAll(organizationId: string, opts: { batch?: number; maxPasses?: number } = {}) {
    const batch = opts.batch ?? 200;
    const maxPasses = opts.maxPasses ?? 25;
    let recorded = 0;
    let finalized = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const r = await meteringEngine.reconcile(organizationId, { limit: batch });
      recorded += r.recorded;
      finalized += r.finalized;
      if (r.scanned < batch) return { recorded, finalized, drained: true };
    }
    return { recorded, finalized, drained: false };
  },

  /**
   * An explicit, audited correction: a NEW ledger row that supersedes the current one. The original is retained
   * (state "superseded"), never edited or deleted. `clientKey` makes a retried correction a no-op.
   */
  async correct(
    organizationId: string,
    input: { ledgerId: string; billableSeconds: number; reason: string; correctedBy: string; clientKey: string },
  ) {
    if (!Number.isInteger(input.billableSeconds) || input.billableSeconds < 0 || input.billableSeconds > 86_400) {
      throw new ValidationError("Invalid request - billableSeconds: must be a whole number between 0 and 86400");
    }
    if (!input.reason.trim()) throw new ValidationError("Invalid request - reason: required");
    return runInTenant({ organizationId }, async () => {
      const original = await usageLedgerRepository.findById({ organizationId, id: input.ledgerId });
      if (!original) throw new NotFoundError("Usage entry not found");
      const key = `correction:${original.id}:${input.clientKey}`.slice(0, 160);
      const existing = await usageLedgerRepository.findByKey({ organizationId, idempotencyKey: key });
      if (existing) return existing; // retried request
      if (original.state === "superseded") throw new ConflictError("This usage entry has already been corrected");
      const row = await usageLedgerRepository.supersede({
        organizationId,
        supersedesId: original.id,
        row: {
          callId: original.callId,
          providerCallId: original.providerCallId,
          idempotencyKey: key,
          source: "correction",
          entryType: "correction",
          state: "final",
          startedAt: original.startedAt,
          endedAt: original.endedAt,
          durationSeconds: original.durationSeconds,
          billableSeconds: input.billableSeconds,
          billableMinutes: Math.ceil(input.billableSeconds / 60),
          roundingPolicy: original.roundingPolicy,
          billableReason: "corrected",
          outcome: original.outcome,
          terminationReason: original.terminationReason,
          occurredAt: original.occurredAt,
          metadata: {
            reason: input.reason.trim().slice(0, 500),
            correctedBy: input.correctedBy,
            previousBillableSeconds: original.billableSeconds,
          },
        },
      });
      if (!row) throw new ConflictError("This usage entry was corrected concurrently; reload and retry");
      return row;
    });
  },
};
