import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { leadsService, type CreateLeadInput } from "./leads.service.js";
import { auditService } from "../audit/audit.service.js";
import { leadStatusEnum } from "../../db/schema.js";
import { parseInput } from "../../shared/validation.js";
import { callsService } from "../calls/calls.service.js";
import { projectsService } from "../projects/projects.service.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import { ProviderConfigError, ProviderRequestError, ValidationError } from "../../shared/errors.js";
import { normalizeIndianMobile } from "../../shared/phone.js";
import { logger } from "../../shared/logger.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { callRateLimitPreHandler } from "../../security/rate-limits.js";

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.enum(leadStatusEnum.enumValues).optional(),
  projectId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  /** Name or phone digits. */
  q: z.string().trim().max(100).optional(),
  /** Paging is opt-in: without `limit` the full scoped list is returned, as before. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const assignBody = z.object({ userId: z.string().uuid().nullable() });
// Optional: call this lead with a specific agent (default: the agent bound to the lead's project, else the org default).
const callBody = z.object({ agentId: z.string().uuid().optional() }).strict().optional();

export async function leadsRoutes(app: FastifyInstance) {
  app.get("/api/leads", async (req, reply) => {
    const { q, limit, offset, ...filters } = parseInput(listQuery, req.query);
    if (limit === undefined && !q) {
      const data = await leadsService.listLeads(requireContext(req), filters);
      return reply.send({ data, total: data.length });
    }
    const page = await leadsService.listLeadsPage(requireContext(req), { ...filters, search: q, limit: limit ?? 25, offset });
    return reply.send({ ...page, limit: limit ?? 25, offset });
  });

  app.post("/api/leads", async (req, reply) => {
    const lead = await leadsService.createLead(requireContext(req), req.body as CreateLeadInput);
    return reply.status(201).send({ data: lead });
  });

  app.patch<{ Params: { id: string } }>("/api/leads/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const lead = await leadsService.updateLeadDetails(requireContext(req), {
      ...(req.body as Record<string, unknown>),
      leadId: id,
    });
    if (!lead) return reply.status(404).send({ error: "Lead not found" });
    return reply.send({ data: lead });
  });

  app.post<{ Params: { id: string } }>("/api/leads/:id/assign", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const { userId } = parseInput(assignBody, req.body);
    const lead = await leadsService.assignLead(requireContext(req), { leadId: id, userId });
    if (!lead) return reply.status(404).send({ error: "Lead not found" });
    return reply.send({ data: lead });
  });

  app.get<{ Params: { id: string } }>("/api/leads/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const lead = await leadsService.getLeadDetail(requireContext(req), { leadId: id });
    if (!lead) {
      return reply.status(404).send({ error: "Lead not found" });
    }
    return reply.send({ data: lead });
  });

  /**
   * "Call Lead" button. Creates the call record, asks the configured
   * telephony provider to place the call, and returns immediately once
   * the provider has accepted the request — it does NOT wait for the
   * call to finish. The media-stream websocket (attached once Exotel
   * connects) drives the live conversation asynchronously.
   */
  app.post<{ Params: { id: string } }>("/api/leads/:id/call", { preHandler: callRateLimitPreHandler }, async (req, reply) => {
    const ctx = requireContext(req);
    const { id } = parseInput(idParams, req.params);
    const lead = await leadsService.getLeadDetail(ctx, { leadId: id });
    if (!lead) {
      return reply.status(404).send({ error: "Lead not found" });
    }

    const project = await projectsService.getProjectWithKnowledge(ctx, { projectId: lead.projectId });
    if (!project) {
      return reply.status(409).send({ error: "Lead's project not found" });
    }

    if (project.status === "archived") {
      return reply.status(409).send({ error: "Project is archived", code: "PROJECT_ARCHIVED" });
    }

    // Exotel needs the customer in E.164; fail clearly here, before creating a call record.
    let toNumber: string;
    try {
      toNumber = normalizeIndianMobile(lead.phone);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(422).send({ error: err.message, code: "INVALID_PHONE" });
      }
      throw err;
    }

    const body = parseInput(callBody, req.body ?? undefined);
    const call = await callsService.createCall(ctx, {
      leadId: lead.id,
      agentId: body?.agentId,
      callType: "outbound",
      counterpartyNumber: toNumber,
      counterpartyName: lead.name,
    });
    await leadsService.updateStatus(ctx, { leadId: lead.id, status: "CALLING" });

    const provider = getTelephonyProvider();

    try {
      const result = await provider.initiateCall({
        toNumber,
        internalCallId: call.id,
        organizationId: ctx.organizationId,
      });
      await callsService.attachProviderCallId(ctx, { callId: call.id, providerCallId: result.providerCallId });
      await auditService.record(ctx, {
        action: "call.initiated",
        entityType: "call",
        entityId: call.id,
        metadata: { callId: call.id, agentId: call.agentId, callType: call.callType, leadId: lead.id, provider: provider.name },
      });

      return reply.status(202).send({
        data: {
          callId: call.id,
          providerCallId: result.providerCallId,
          status: result.status,
          provider: provider.name,
        },
      });
    } catch (err) {
      await callsService.markFailed(ctx, { callId: call.id }).catch(() => undefined);

      if (err instanceof ProviderConfigError) {
        logger.warn("leads.routes: call blocked by missing provider config", { provider: err.provider });
        return reply.status(503).send({
          error: `Telephony provider not configured: ${err.message}`,
          code: "PROVIDER_NOT_CONFIGURED",
        });
      }
      if (err instanceof ProviderRequestError) {
        logger.error("leads.routes: provider rejected call", { provider: err.provider, error: err.message });
        return reply.status(502).send({ error: "The telephony provider could not place the call.", code: "PROVIDER_ERROR" });
      }
      logger.error("leads.routes: unexpected error placing call", {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.status(500).send({ error: "Unexpected error placing the call." });
    }
  });
}
