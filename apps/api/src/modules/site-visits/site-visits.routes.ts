import type { FastifyInstance } from "fastify";
import { siteVisitsService } from "./site-visits.service.js";
import { requireContext } from "../../auth/auth.plugin.js";

export async function siteVisitsRoutes(app: FastifyInstance) {
  app.get("/api/site-visits", async (req, reply) => {
    return reply.send({ data: await siteVisitsService.list(requireContext(req)) });
  });

  app.get<{ Params: { id: string } }>("/api/site-visits/:id", async (req, reply) => {
    const visit = await siteVisitsService.getById(requireContext(req), { id: req.params.id });
    if (!visit) return reply.status(404).send({ error: "Site visit not found" });
    return reply.send({ data: visit });
  });
}
