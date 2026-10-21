import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditService } from "./audit.service.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO timestamp").optional(),
  action: z.string().min(1).max(100).optional(),
  entityType: z.string().min(1).max(50).optional(),
  entityId: z.string().regex(UUID, "must be a UUID").optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit-logs", async (req, reply) => {
    const q = parseInput(listQuery, req.query);
    return reply.send(
      await auditService.list(requireContext(req), { ...q, before: q.before ? new Date(q.before) : undefined }),
    );
  });
}
