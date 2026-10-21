import type { FastifyInstance } from "fastify";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { agentIdParamsSchema } from "../agents/agents.validation.js";
import { playgroundService } from "./playground.service.js";

/** Text test conversations with a saved agent (simulated: nothing is dialed). */
export async function playgroundRoutes(app: FastifyInstance) {
  app.post("/api/agents/:id/playground", async (req, reply) => {
    const { id } = parseInput(agentIdParamsSchema, req.params);
    return reply.status(201).send({ data: await playgroundService.start(requireContext(req), id, req.body) });
  });
  app.post<{ Params: { sessionId: string } }>("/api/playground/:sessionId/messages", async (req, reply) => {
    return reply.send({ data: await playgroundService.message(requireContext(req), req.params.sessionId, req.body) });
  });
  app.delete<{ Params: { sessionId: string } }>("/api/playground/:sessionId", async (req, reply) => {
    return reply.send({ data: await playgroundService.end(requireContext(req), req.params.sessionId) });
  });
}
