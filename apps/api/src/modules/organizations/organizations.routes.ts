import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { organizationsService } from "./organizations.service.js";

const renameBody = z.object({ name: z.string().trim().min(1).max(200) });

export async function organizationsRoutes(app: FastifyInstance) {
  app.get("/api/organization", async (req, reply) => {
    return reply.send({ data: await organizationsService.get(requireContext(req)) });
  });

  app.patch("/api/organization", async (req, reply) => {
    const body = parseInput(renameBody, req.body);
    return reply.send({ data: await organizationsService.rename(requireContext(req), body) });
  });
}
