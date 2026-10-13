import type { FastifyInstance } from "fastify";
import { callsService } from "./calls.service.js";
import { isTelephonyAuthorized } from "../../security/telephony-auth.js";
import { LimitExceededError, NotFoundError, ServiceUnavailableError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";

/** First non-empty string among the payload keys (Exotel's naming varies between applets). */
function pick(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Inbound telephony webhook: the provider tells us a call just arrived on one of our numbers.
 *
 *   GET|POST /api/telephony/exotel/inbound?token=<secret>
 *     CallSid, CallTo (the dialed number; also `To`), CallFrom (the caller; also `From`)
 *
 * Exotel's Passthru/dynamic-URL applets call with GET query parameters by default and can also POST form or JSON,
 * so both are accepted. Authentication is the same shared secret as the other telephony endpoints (?token= or Basic).
 *
 * The DIALED number alone decides the agent and the organization (calls.service startInboundCall); nothing in the
 * payload can name a tenant. Unknown or unassigned numbers get 404 and create nothing. The call is created
 * idempotently on CallSid, so provider retries are harmless; the audio then arrives on the media stream, which finds
 * this record by call_sid. Errors that are ours (database trouble, shutting down) are 5xx so the provider can retry
 * or fail over; problems with the request itself are 4xx so it does not.
 */
export async function inboundRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/telephony/exotel/inbound",
    handler: async (req, reply) => {
      if (!isTelephonyAuthorized(req)) {
        logger.warn("inbound: unauthorized webhook rejected");
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const payload = { ...((req.query ?? {}) as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
      const providerCallId = pick(payload, "CallSid", "Sid", "call_sid");
      const dialedNumber = pick(payload, "CallTo", "To", "to");
      const callerNumber = pick(payload, "CallFrom", "From", "from");
      if (!providerCallId || !dialedNumber) {
        return reply.status(400).send({ ok: false, error: "CallSid and CallTo are required" });
      }

      try {
        const call = await callsService.startInboundCall({ dialedNumber, callerNumber, providerCallId });
        return reply.status(200).send({ ok: true, callId: call.id });
      } catch (err) {
        if (err instanceof NotFoundError) {
          logger.warn("inbound: no agent answers the dialed number", { providerCallId });
          return reply.status(404).send({ ok: false, error: "No agent answers this number" });
        }
        if (err instanceof LimitExceededError) {
          logger.warn("inbound: refused by organization limit", { providerCallId, limit: err.code });
          return reply.status(429).send({ ok: false, error: err.message, code: err.code });
        }
        if (err instanceof ServiceUnavailableError) {
          return reply.status(503).send({ ok: false, error: err.message, code: err.code });
        }
        throw err; // our failure: 500 through the app error handler, so the provider retries
      }
    },
  });
}
