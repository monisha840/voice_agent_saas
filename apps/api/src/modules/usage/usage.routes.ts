import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { usageService } from "./usage.service.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";

const rangeQuery = z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() });

export async function usageRoutes(app: FastifyInstance) {
  app.get("/api/usage/summary", async (req, reply) => {
    const query = parseInput(rangeQuery, req.query);
    return reply.send({ data: await usageService.summary(requireContext(req), query) });
  });

  app.get("/api/usage/daily", async (req, reply) => {
    const query = parseInput(rangeQuery, req.query);
    return reply.send(await usageService.daily(requireContext(req), query));
  });
}
