import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { agentPhoneNumbersRepository } from "../../db/repositories/agent-phone-numbers.repository.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { normalizeIndianMobile } from "../../shared/phone.js";
import { auditService } from "../audit/audit.service.js";

/** E.164 for Indian mobiles we can normalize, otherwise the digits as given (international numbers). */
export function normalizeRoutingNumber(input: string): string {
  try {
    return normalizeIndianMobile(input);
  } catch {
    const cleaned = input.replace(/[\s()-]/g, "");
    if (!/^\+[0-9]{6,20}$/.test(cleaned)) throw new ValidationError("Phone number must be in international format, e.g. +919876543210");
    return cleaned;
  }
}

async function requireAgent(ctx: RequestContext, agentId: string) {
  const agent = await agentsRepository.findById({ organizationId: ctx.organizationId, id: agentId });
  if (!agent) throw new NotFoundError("Agent not found");
  return agent;
}

/** Which numbers an agent answers (inbound routing). Provider-agnostic: no telephony provider is involved here. */
export const agentPhoneNumbersService = {
  async list(ctx: RequestContext, params: { agentId: string }) {
    assertCan(ctx, "agents:read");
    await requireAgent(ctx, params.agentId);
    return agentPhoneNumbersRepository.listForAgent({ organizationId: ctx.organizationId, agentId: params.agentId });
  },

  async add(ctx: RequestContext, params: { agentId: string; phoneNumber: string; label?: string | null }) {
    assertCan(ctx, "agents:manage");
    await requireAgent(ctx, params.agentId);
    const phoneNumber = normalizeRoutingNumber(params.phoneNumber);
    try {
      const row = await agentPhoneNumbersRepository.add({
        organizationId: ctx.organizationId,
        agentId: params.agentId,
        phoneNumber,
        label: params.label ?? null,
      });
      await auditService.record(ctx, {
        action: "agent.phone_number_added",
        entityType: "agent",
        entityId: params.agentId,
        metadata: { phoneNumber },
      });
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictError("That number is already assigned to an agent");
      throw err;
    }
  },

  async remove(ctx: RequestContext, params: { agentId: string; id: string }) {
    assertCan(ctx, "agents:manage");
    await requireAgent(ctx, params.agentId);
    const row = await agentPhoneNumbersRepository.remove({ organizationId: ctx.organizationId, agentId: params.agentId, id: params.id });
    if (!row) throw new NotFoundError("Phone number not found");
    await auditService.record(ctx, {
      action: "agent.phone_number_removed",
      entityType: "agent",
      entityId: params.agentId,
      metadata: { phoneNumber: row.phoneNumber },
    });
  },
};
