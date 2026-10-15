/**
 * Authenticates a media-stream WebSocket upgrade, BEFORE any audio or call event is processed.
 *
 *  1. A per-call token (?st=): signature, expiry, audience, call and organization claims, then a bounded use count
 *     shared across API instances (reconnects are allowed up to STREAM_TOKEN_MAX_USES; beyond that it is a replay).
 *     When a token is present it is the ONLY credential considered: a bad token is never rescued by the shared secret.
 *  2. Otherwise, if STREAM_ALLOW_STATIC_SECRET is on, the deployment's shared webhook secret (what inbound calls and
 *     an Exotel flow's Voicebot applet can carry, because their URL is configured once and cannot hold a per-call
 *     value). That proves the peer knows the secret, nothing about which call it may touch, so such a stream gets NO
 *     caller-chosen call id: the call is resolved from the provider's own start event, and the handler additionally
 *     requires the call to be live and not already streaming.
 *
 *  1b. A per-call grant (?g=, opt-in; minted by /api/telephony/exotel/stream-url, see stream-grant.ts): looked up by
 *     hash, unexpired, use-bounded, and bound to the call record it names and that call's provider call id (the
 *     handler then requires the start event's call_sid to equal it). Like `st`, a presented grant is the ONLY
 *     credential considered. With STREAM_REQUIRE_GRANT=true the static secret alone is never accepted.
 *
 * The result is the hints the stream handler binds to (expected call and organization). The token and the secret are
 * never written to a log or an error.
 */
import type { FastifyRequest } from "fastify";
import { getConfig } from "../config/env.js";
import { streamTokenUsesRepository } from "../db/repositories/security.repository.js";
import type { MediaStreamHints } from "../websocket/exotel-media-stream.handler.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../runtime/metrics.js";
import { securityEvents } from "./security-events.js";
import { isTelephonyAuthorized } from "./telephony-auth.js";
import { StreamTokenError, verifyStreamToken } from "./stream-token.js";
import { hashGrant, isWellFormedGrant } from "./stream-grant.js";
import { streamGrantsRepository } from "../db/repositories/security.repository.js";
import { callsService } from "../modules/calls/calls.service.js";

export async function authenticateMediaStream(req: Pick<FastifyRequest, "query" | "headers" | "ip">): Promise<MediaStreamHints | null> {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const cfg = getConfig();
  const deny = async (reason: string, extra: Record<string, unknown> = {}) => {
    metrics.inc("stream_auth_denied_total", { reason });
    logger.warn("media-stream: connection rejected", { reason, ...extra });
    await securityEvents.record({
      type: "access.stream_denied",
      outcome: "denied",
      ip: req.ip,
      metadata: { reason, ...extra },
    });
    return null;
  };

  const grantPresented = query.g;
  if (grantPresented !== undefined) {
    if (!isWellFormedGrant(grantPresented)) return deny("grant_malformed");
    const grantHash = hashGrant(grantPresented);
    const consumed = await streamGrantsRepository.consume({ grantHash, maxUses: cfg.stream.grantMaxUses });
    if (!consumed) {
      const why = await streamGrantsRepository.diagnose({ grantHash });
      return deny(why === "unknown" ? "grant_unknown" : why === "expired" ? "grant_expired" : "grant_reused");
    }
    // The organization is whatever the call record says; the grant itself carries no tenant data.
    const call = await callsService.getCallByIdSystem({ callId: consumed.callId });
    if (!call) return deny("grant_call_missing", { callId: consumed.callId });
    if (!call.providerCallId || call.providerCallId !== consumed.providerCallId) return deny("grant_call_mismatch", { callId: call.id });
    return {
      auth: "grant",
      internalCallId: call.id,
      streamClaims: { callId: call.id, organizationId: call.organizationId, jti: grantHash.slice(0, 16) },
    };
  }

  const presented = query.st;
  if (presented !== undefined) {
    try {
      const claims = await verifyStreamToken(presented);
      const uses = await streamTokenUsesRepository.consume({ jti: claims.jti, callId: claims.callId, expiresAt: claims.expiresAt });
      if (uses > cfg.stream.tokenMaxUses) return deny("token_reused", { callId: claims.callId, uses });
      return { auth: "token", internalCallId: claims.callId, streamClaims: { callId: claims.callId, organizationId: claims.organizationId, jti: claims.jti } };
    } catch (err) {
      if (err instanceof StreamTokenError) return deny(`token_${err.reason}`);
      throw err;
    }
  }

  if (cfg.stream.requireGrant) return deny("grant_required");
  if (cfg.stream.allowStaticSecret && isTelephonyAuthorized(req)) {
    // A caller-chosen call id is honoured only with the mock provider (local simulator); with a real provider the
    // call is whatever the provider's own start event names.
    const requested = typeof query.internalCallId === "string" ? query.internalCallId : undefined;
    return { auth: "static", internalCallId: cfg.telephonyProvider === "mock" ? requested : undefined };
  }
  return deny(cfg.stream.allowStaticSecret ? "unauthorized" : "token_required");
}
