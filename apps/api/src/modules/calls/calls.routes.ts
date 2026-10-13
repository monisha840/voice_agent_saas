import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { callStatusEnum, callTypeEnum } from "../../db/schema.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { callRateLimitPreHandler } from "../../security/rate-limits.js";
import { parseInput } from "../../shared/validation.js";
import { callsService } from "./calls.service.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import { handleExotelMediaStream } from "../../websocket/exotel-media-stream.handler.js";
import { isTelephonyAuthorized } from "../../security/telephony-auth.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { systemContext } from "../../auth/context.js";
import { logger } from "../../shared/logger.js";
import { lifecycle } from "../../runtime/lifecycle.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO timestamp").optional(),
  status: z.enum(callStatusEnum.enumValues).optional(),
  agentId: z.string().uuid().optional(),
  callType: z.enum(callTypeEnum.enumValues).optional(),
});

/** "test" runs a simulated call when no number is given; "outbound" needs a number or a lead. Inbound calls arrive via telephony, never from here. */
const placeCallBody = z
  .object({
    agentId: z.string().uuid(),
    callType: z.enum(["outbound", "test"]),
    toNumber: z.string().trim().min(3).max(32).optional(),
    leadId: z.string().uuid().optional(),
  })
  .strict();

export async function callsRoutes(app: FastifyInstance) {
  app.get("/api/calls", async (req, reply) => {
    const q = parseInput(listQuery, req.query);
    return reply.send(
      await callsService.listCalls(requireContext(req), { ...q, before: q.before ? new Date(q.before) : undefined }),
    );
  });

  app.post("/api/calls", { preHandler: callRateLimitPreHandler }, async (req, reply) => {
    const body = parseInput(placeCallBody, req.body);
    try {
      const result = await callsService.placeCall(requireContext(req), body);
      return reply.status(202).send({ data: result });
    } catch (err) {
      if (err instanceof ProviderConfigError) {
        logger.warn("calls.routes: call blocked by missing provider config", { provider: err.provider });
        return reply.status(503).send({ error: `Telephony provider not configured: ${err.message}`, code: "PROVIDER_NOT_CONFIGURED" });
      }
      if (err instanceof ProviderRequestError) {
        logger.error("calls.routes: provider rejected call", { provider: err.provider, error: err.message });
        return reply.status(502).send({ error: "The telephony provider could not place the call.", code: "PROVIDER_ERROR" });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/calls/:id", async (req, reply) => {
    const call = await callsService.getCallDetail(requireContext(req), { callId: req.params.id });
    if (!call) {
      return reply.status(404).send({ error: "Call not found" });
    }
    return reply.send({ data: call });
  });

  /**
   * Exotel calls this URL (configured as StatusCallback on the
   * Calls/connect request) as the call progresses: answered -> terminal.
   * Exotel requires an HTTP 200 within 15 seconds and retries otherwise, so
   * we apply the status change, reply immediately, and run the (slow,
   * LLM-backed) post-call finalization in the background. Finalization is
   * idempotent, so a retried callback cannot duplicate anything.
   *
   * Error handling is deliberate: a payload we cannot parse gets 200 (retrying cannot help), while an internal
   * failure (database down) gets 500 so Exotel retries the callback instead of the status change being lost.
   */
  app.post("/api/telephony/exotel/status-callback", async (req, reply) => {
    if (!isTelephonyAuthorized(req)) {
      logger.warn("calls.routes: unauthorized status callback rejected");
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const provider = getTelephonyProvider();

    // A payload we cannot understand will never become understandable: answer 200 so the provider stops retrying it.
    let parsed: ReturnType<typeof provider.parseStatusCallback>;
    try {
      parsed = provider.parseStatusCallback((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      logger.error("calls.routes: unusable status callback payload, not retrying", {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.status(200).send({ ok: false });
    }

    // Anything else that fails (the database, a hook) is OUR transient problem: let it surface as a 500 so the
    // provider retries. That is safe because applying a status is idempotent (atomic terminal transition, rank guard).
    const { call, finalizeCallId } = await callsService.applyProviderStatus({
      providerCallId: parsed.providerCallId,
      status: parsed.status,
      durationSeconds: parsed.durationSeconds,
      recordingUrl: parsed.recordingUrl,
    });
    if (finalizeCallId && call) {
      // Tracked so a graceful shutdown waits for the summary instead of dropping it.
      lifecycle.trackTask(
        callsService
          .finalizeCall(systemContext(call.organizationId, "exotel-webhook"), { callId: finalizeCallId })
          .catch((err: unknown) => {
            logger.error("calls.routes: post-call finalization failed", {
              callId: finalizeCallId,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * AgentStream media-stream WebSocket. Exotel is the WS client: once
   * the call is answered, Exotel connects here (the StreamUrl we gave
   * it on Calls/connect) and streams bidirectional audio. See
   * websocket/exotel-media-stream.handler.ts for the frame protocol.
   * `internalCallId` is optional: if Exotel does not pass our query string
   * through, the handler resolves the call from the start event's call_sid.
   */
  app.get("/api/telephony/exotel/media-stream", { websocket: true }, (socket, req) => {
    if (!isTelephonyAuthorized(req)) {
      logger.warn("media-stream: unauthorized connection rejected");
      socket.close(1008, "unauthorized");
      return;
    }
    const internalCallId = (req.query as Record<string, string | undefined>)?.internalCallId;
    handleExotelMediaStream(socket, { internalCallId });
  });
}
