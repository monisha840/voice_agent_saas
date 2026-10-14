import type { FastifyInstance } from "fastify";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { agentsService } from "./agents.service.js";
import { agentIdParamsSchema } from "./agents.validation.js";
import { voicePreviewService } from "./voice-preview.js";

export async function agentsRoutes(app: FastifyInstance) {
  const idOf = (params: unknown) => parseInput(agentIdParamsSchema, params).id;

  // Selection list for every role that can place calls (id, name, persona name, status only). Its own path so it can
  // never be confused with the full, agents:read-gated /api/agents/:id.
  app.get("/api/agent-options", async (req, reply) => {
    return reply.send({ data: await agentsService.listOptions(requireContext(req)) });
  });

  // Plays a sample in a voice, with no fallback: a speaker name the provider does not know is reported, not hidden.
  app.post("/api/agents/voice-preview", async (req, reply) => {
    return reply.send({ data: await voicePreviewService.preview(requireContext(req), req.body) });
  });

  app.get("/api/agents", async (req, reply) => {
    return reply.send({ data: await agentsService.list(requireContext(req), req.query) });
  });

  app.get("/api/agents/:id", async (req, reply) => {
    return reply.send({ data: await agentsService.get(requireContext(req), idOf(req.params)) });
  });

  app.post("/api/agents", async (req, reply) => {
    return reply.status(201).send({ data: await agentsService.create(requireContext(req), req.body) });
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    return reply.send({ data: await agentsService.update(requireContext(req), idOf(req.params), req.body) });
  });

  app.post("/api/agents/:id/archive", async (req, reply) => {
    return reply.send({ data: await agentsService.archive(requireContext(req), idOf(req.params)) });
  });

  app.post("/api/agents/:id/unarchive", async (req, reply) => {
    return reply.send({ data: await agentsService.unarchive(requireContext(req), idOf(req.params)) });
  });

  app.post("/api/agents/:id/set-default", async (req, reply) => {
    return reply.send({ data: await agentsService.setDefault(requireContext(req), idOf(req.params)) });
  });

  app.put("/api/agents/:id/knowledge", async (req, reply) => {
    return reply.send({ data: await agentsService.replaceKnowledge(requireContext(req), idOf(req.params), req.body) });
  });
}
