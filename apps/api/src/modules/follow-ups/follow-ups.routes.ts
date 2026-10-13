import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { followUpsService } from "./follow-ups.service.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";

const idParams = z.object({ id: z.string().uuid() });

/** Part of the Sales module's routes: only reachable while the organization has Sales enabled. */
export async function followUpsRoutes(app: FastifyInstance) {
  /** The queue: open follow-ups on the leads the caller may see, oldest first. */
  app.get("/api/follow-ups", async (req, reply) => {
    return reply.send({ data: await followUpsService.listOpen(requireContext(req)) });
  });

  app.get<{ Params: { id: string } }>("/api/leads/:id/follow-ups", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    return reply.send({ data: await followUpsService.listForLead(requireContext(req), { leadId: id }) });
  });

  app.post<{ Params: { id: string } }>("/api/follow-ups/:id/done", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const row = await followUpsService.resolve(requireContext(req), { id });
    if (!row) return reply.status(404).send({ error: "Follow-up not found" });
    return reply.send({ data: row });
  });
}
