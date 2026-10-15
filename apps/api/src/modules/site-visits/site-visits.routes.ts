import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { siteVisitsService } from "./site-visits.service.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";

const idParams = z.object({ id: z.string().uuid() });
const isoTime = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO timestamp");
const listQuery = z.object({
  /** Paging is opt-in: without `view` the full scoped list is returned, as before. */
  view: z.enum(["upcoming", "past", "cancelled", "all"]).optional(),
  leadId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
// The organization and project are never taken from the browser: the project is the lead's own.
const createBody = z.object({ leadId: z.string().uuid(), scheduledAt: isoTime }).strict();
const rescheduleBody = z.object({ scheduledAt: isoTime }).strict();

export async function siteVisitsRoutes(app: FastifyInstance) {
  app.get("/api/site-visits", async (req, reply) => {
    const q = parseInput(listQuery, req.query);
    if (!q.view && !q.leadId) return reply.send({ data: await siteVisitsService.list(requireContext(req)) });
    const page = await siteVisitsService.listPage(requireContext(req), {
      view: q.view ?? "all",
      leadId: q.leadId,
      limit: q.limit,
      offset: q.offset,
    });
    return reply.send({ ...page, limit: q.limit, offset: q.offset });
  });

  app.post("/api/site-visits", async (req, reply) => {
    const body = parseInput(createBody, req.body);
    const visit = await siteVisitsService.createForLead(requireContext(req), body);
    return reply.status(201).send({ data: visit });
  });

  app.get<{ Params: { id: string } }>("/api/site-visits/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const visit = await siteVisitsService.getById(requireContext(req), { id });
    if (!visit) return reply.status(404).send({ error: "Site visit not found" });
    return reply.send({ data: visit });
  });

  app.post<{ Params: { id: string } }>("/api/site-visits/:id/reschedule", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const { scheduledAt } = parseInput(rescheduleBody, req.body);
    return reply.send({ data: await siteVisitsService.reschedule(requireContext(req), { id, scheduledAt }) });
  });

  app.post<{ Params: { id: string } }>("/api/site-visits/:id/cancel", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    return reply.send({ data: await siteVisitsService.cancel(requireContext(req), { id }) });
  });
}
