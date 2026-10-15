import type { FastifyInstance } from "fastify";
import { callsService } from "./calls.service.js";
import { isTelephonyAuthorized } from "../../security/telephony-auth.js";
import { getConfig } from "../../config/env.js";
import { mintStreamGrant } from "../../security/stream-grant.js";
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
  /**
   * Voicebot applet "dynamic endpoint" (opt-in, UNVERIFIED against real Exotel; see docs/security/stream-tokens-and-dependencies.md).
   * Exotel GETs this URL with CallSid, CallFrom, CallTo, Direction, ... and expects 200 {"url": "wss://..."}. We resolve
   * (or, for inbound, register) the call exactly like the inbound webhook, mint a short per-call grant and return the
   * media-stream URL carrying only that grant. The shared secret is never placed in the returned URL.
   */
  app.route({
    method: ["GET", "POST"],
    url: "/api/telephony/exotel/stream-url",
    handler: async (req, reply) => {
      if (!isTelephonyAuthorized(req)) {
        logger.warn("stream-url: unauthorized request rejected");
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const payload = { ...((req.query ?? {}) as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
      const providerCallId = pick(payload, "CallSid", "Sid", "call_sid");
      const dialedNumber = pick(payload, "CallTo", "To", "to");
      const callerNumber = pick(payload, "CallFrom", "From", "from");
      const direction = (pick(payload, "Direction", "direction") ?? "").toLowerCase();
      if (!providerCallId) return reply.status(400).send({ error: "CallSid is required" });

      try {
        let call = await callsService.getCallByProviderCallId({ providerCallId });
        if (!call && direction.startsWith("outbound")) {
          // Outbound flow mode: the record is linked to CallSid right after Calls/connect returns; allow for that race.
          for (let i = 0; i < 10 && !call; i++) {
            await new Promise((r) => setTimeout(r, 300));
            call = await callsService.getCallByProviderCallId({ providerCallId });
          }
        } else if (!call) {
          if (!dialedNumber) return reply.status(400).send({ error: "CallTo is required for an inbound call" });
          call = await callsService.startInboundCall({ dialedNumber, callerNumber, providerCallId });
        }
        if (!call) return reply.status(404).send({ error: "Unknown call" });
        if (call.status === "completed" || call.status === "failed") return reply.status(409).send({ error: "Call is not live" });

        const { grant } = await mintStreamGrant({ callId: call.id, providerCallId });
        const configured = getConfig().exotel.webhookBaseUrl.replace(/\/+$/, "");
        const base = configured || `https://${req.headers.host ?? "localhost"}`;
        const wsBase = base.replace(/^https?/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"));
        return reply.status(200).send({ url: `${wsBase}/api/telephony/exotel/media-stream?g=${grant}` });
      } catch (err) {
        if (err instanceof NotFoundError) return reply.status(404).send({ error: "No agent answers this number" });
        if (err instanceof LimitExceededError) return reply.status(429).send({ error: err.message, code: err.code });
        if (err instanceof ServiceUnavailableError) return reply.status(503).send({ error: err.message, code: err.code });
        throw err;
      }
    },
  });
}
