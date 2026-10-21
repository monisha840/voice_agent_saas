import type { FastifyInstance } from "fastify";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { agentConfigService } from "./agent-config.service.js";
import { agentConfigQuerySchema } from "./agent-config.validation.js";

export async function agentConfigRoutes(app: FastifyInstance) {
  // Legacy façade: the successor is /api/agents.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Deprecation", "true");
    reply.header("Link", '</api/agents>; rel="successor-version"');
    return payload;
  });

  app.get("/api/agent-config", async (req, reply) => {
    const query = parseInput(agentConfigQuerySchema, req.query);
    return reply.send({ data: await agentConfigService.getForManagement(requireContext(req), query) });
  });

  app.put("/api/agent-config", async (req, reply) => {
    return reply.send({ data: await agentConfigService.upsert(requireContext(req), req.body) });
  });

  app.delete("/api/agent-config", async (req, reply) => {
    const query = parseInput(agentConfigQuerySchema, req.query);
    return reply.send({ data: await agentConfigService.reset(requireContext(req), query) });
  });
}
