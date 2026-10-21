/**
 * System-side metering operations on a tenant. `recordCall` is the integration point for the call lifecycle (call it
 * from call finalization / terminal-status handling with a system context); the entitlement evaluator also
 * reconciles on demand, so usage is correct even if that hook is never wired.
 * `correct` is an operator action (system actors only): a tenant can never edit its own bill.
 */
import type { RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { meteringEngine, type MeterSource } from "./metering-engine.js";

const meteringServiceImpl = {
  /** Meters one call from its persisted record. The caller supplies only the call id: never a duration or a cost. */
  async recordCall(ctx: RequestContext, input: { callId: string; source?: MeterSource }) {
    const call = await callsRepository.findById({ organizationId: ctx.organizationId, id: input.callId });
    if (!call) throw new NotFoundError("Call not found");
    return meteringEngine.meterCall(ctx.organizationId, call, input.source ?? "call_lifecycle");
  },

  async correct(
    ctx: RequestContext,
    input: { ledgerId: string; billableSeconds: number; reason: string; clientKey: string },
  ) {
    if (ctx.actor.type !== "system") throw new ForbiddenError("Usage corrections are an operator action");
    const entry = await meteringEngine.correct(ctx.organizationId, { ...input, correctedBy: `system:${ctx.actor.source}` });
    await auditService.record(ctx, {
      action: "usage.corrected",
      entityType: "usage_ledger",
      entityId: entry.id,
      metadata: { supersedes: entry.supersedesId, billableSeconds: entry.billableSeconds, reason: input.reason },
    });
    return entry;
  },
};

export const meteringService = tenantScoped(meteringServiceImpl);
