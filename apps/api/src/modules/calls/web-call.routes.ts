import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { getConfig } from "../../config/env.js";
import { callRateLimitPreHandler } from "../../security/rate-limits.js";
import { parseInput } from "../../shared/validation.js";
import { logger } from "../../shared/logger.js";
import { handleExotelMediaStream } from "../../websocket/exotel-media-stream.handler.js";
import { auditService } from "../audit/audit.service.js";
import { callsService } from "./calls.service.js";

// leadId (optional): talk to the agent AS that lead, so lead tools (slots, booking, follow-ups on the lead) work as on a real call.
const createBody = z.object({ agentId: z.string().uuid().optional(), leadId: z.string().uuid().optional() }).strict().optional();
const streamQuery = z.object({ callId: z.string().uuid() });

/** Calls whose stream was already claimed by a socket: a web call is single-use. */
const claimed = new Set<string>();

/**
 * Browser "web call": a test call whose audio comes from the logged-in user's microphone instead of a phone line.
 * It needs no telephony provider. The browser plays the part Exotel plays on a real call: it speaks the SAME stream
 * protocol (connected / start / media / mark / stop in, media / mark / clear out; 16-bit 8 kHz PCM), so the call
 * pipeline (turn detection, STT, conversation, TTS, guards, usage) is exactly the one a phone call runs.
 *
 *   POST /api/calls/web                 create the call record (login + calls:create + the per-organization limits)
 *   GET  /api/web-call/stream?callId=   WebSocket; session cookie, the caller's own call, not yet used
 *
 * These paths are NOT public: through a tunnel or any non-local host the public-access guard answers 404.
 * Temporary channel for use until Exotel AgentStream is enabled; nothing here replaces the Exotel integration.
 */
export async function webCallRoutes(app: FastifyInstance) {
  app.post("/api/calls/web", { preHandler: callRateLimitPreHandler }, async (req, reply) => {
    const body = parseInput(createBody, req.body ?? undefined);
    const ctx = requireContext(req);
    const call = await callsService.createCall(ctx, { agentId: body?.agentId, leadId: body?.leadId, callType: "test" });
    await auditService.record(ctx, {
      action: "call.initiated",
      entityType: "call",
      entityId: call.id,
      metadata: { callId: call.id, agentId: call.agentId, leadId: call.leadId, callType: call.callType, provider: "browser" },
    });
    return reply.status(201).send({ data: { callId: call.id, agentId: call.agentId, sampleRate: 8000 } });
  });

  app.get("/api/web-call/stream", { websocket: true }, async (socket, req) => {
    // The browser starts talking the moment the socket opens. Validation below is asynchronous, so hold what arrives
    // and replay it once the stream handler has attached its own listener (otherwise `start` would be lost).
    const early: Array<{ data: Buffer; isBinary: boolean }> = [];
    const hold = (data: Buffer, isBinary: boolean) => early.push({ data, isBinary });
    socket.on("message", hold);
    const refuse = (reason: string) => {
      logger.warn("web-call: connection refused", { reason });
      socket.close(1008, reason);
    };
    // Browsers always send Origin on a WebSocket handshake and cookies ride along, so a foreign page must be refused.
    const origin = req.headers.origin;
    if (origin && !getConfig().auth.allowedOrigins.includes(origin)) return refuse("origin not allowed");
    const ctx = req.ctx;
    if (!ctx || ctx.actor.type !== "user") return refuse("login required");
    const parsed = streamQuery.safeParse(req.query);
    if (!parsed.success) return refuse("callId required");
    const { callId } = parsed.data;

    let call: Awaited<ReturnType<typeof callsService.getCallByIdSystem>>;
    try {
      call = await callsService.getCallByIdSystem({ callId });
    } catch (err) {
      logger.error("web-call: could not look up the call", { error: err instanceof Error ? err.message : String(err) });
      return refuse("lookup failed");
    }
    const own = call && call.organizationId === ctx.organizationId && call.initiatedByUserId === ctx.actor.userId;
    if (!call || !own || call.callType !== "test" || call.status !== "initiating" || claimed.has(callId)) {
      return refuse("call not available");
    }
    claimed.add(callId);
    socket.on("close", () => setTimeout(() => claimed.delete(callId), 60_000).unref?.());
    socket.off("message", hold);
    handleExotelMediaStream(socket, { internalCallId: callId });
    for (const m of early) socket.emit("message", m.data, m.isBinary);
  });
}
