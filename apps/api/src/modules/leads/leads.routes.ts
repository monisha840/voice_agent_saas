import type { FastifyInstance } from "fastify";
import { leadsService } from "./leads.service.js";
import { callsService } from "../calls/calls.service.js";
import { projectsService } from "../projects/projects.service.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";

export async function leadsRoutes(app: FastifyInstance) {
  app.get("/api/leads", async (_req, reply) => {
    const data = await leadsService.listLeads();
    return reply.send({ data });
  });

  app.get<{ Params: { id: string } }>("/api/leads/:id", async (req, reply) => {
    const lead = await leadsService.getLeadDetail({ leadId: req.params.id });
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
  app.post<{ Params: { id: string } }>("/api/leads/:id/call", async (req, reply) => {
    const lead = await leadsService.getLeadDetail({ leadId: req.params.id });
    if (!lead) {
      return reply.status(404).send({ error: "Lead not found" });
    }

    const project = await projectsService.getProjectWithKnowledge({ projectId: lead.projectId });
    if (!project) {
      return reply.status(409).send({ error: "Lead's project not found" });
    }

    const call = await callsService.createCall({ leadId: lead.id });
    await leadsService.updateStatus({ leadId: lead.id, status: "CALLING" });

    const provider = getTelephonyProvider();

    try {
      const result = await provider.initiateCall({
        toNumber: lead.phone,
        internalCallId: call.id,
      });
      await callsService.attachProviderCallId({ callId: call.id, providerCallId: result.providerCallId });

      return reply.status(202).send({
        data: {
          callId: call.id,
          providerCallId: result.providerCallId,
          status: result.status,
          provider: provider.name,
        },
      });
    } catch (err) {
      await callsService.markFailed({ callId: call.id }).catch(() => undefined);

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
