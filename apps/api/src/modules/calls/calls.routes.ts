import type { FastifyInstance } from "fastify";
import { callsService } from "./calls.service.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import { handleExotelMediaStream } from "../../websocket/exotel-media-stream.handler.js";
import { logger } from "../../shared/logger.js";

export async function callsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/calls/:id", async (req, reply) => {
    const call = await callsService.getCallDetail({ callId: req.params.id });
    if (!call) {
      return reply.status(404).send({ error: "Call not found" });
    }
    return reply.send({ data: call });
  });

  /**
   * Exotel calls this URL (configured as StatusCallback on the
   * Calls/connect request) as the call progresses: ringing -> answered
   * -> completed. We correlate back to our call record via the
   * provider's own call id embedded in the callback payload.
   */
  app.post("/api/telephony/exotel/status-callback", async (req, reply) => {
    const provider = getTelephonyProvider();
    try {
      const parsed = provider.parseStatusCallback(req.body as Record<string, unknown>);
      await callsService.updateStatusFromProvider({
        providerCallId: parsed.providerCallId,
        status: parsed.status,
        durationSeconds: parsed.durationSeconds,
        recordingUrl: parsed.recordingUrl,
      });
      return reply.status(200).send({ ok: true });
    } catch (err) {
      logger.error("calls.routes: failed to process status callback", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Always 200 to a webhook sender even on internal failure, so the
      // provider doesn't retry-storm us; the failure is logged server-side.
      return reply.status(200).send({ ok: false });
    }
  });

  /**
   * AgentStream media-stream WebSocket. Exotel is the WS client: once
   * the call is answered, Exotel connects here (the StreamUrl we gave
   * it on Calls/connect) and streams bidirectional audio. See
   * websocket/exotel-media-stream.handler.ts for the frame protocol.
   */
  app.get("/api/telephony/exotel/media-stream", { websocket: true }, (socket, req) => {
    const internalCallId = (req.query as Record<string, string>)?.internalCallId;
    if (!internalCallId) {
      logger.warn("media-stream: connection without internalCallId, closing");
      socket.close();
      return;
    }
    void handleExotelMediaStream(socket, internalCallId);
  });
}
