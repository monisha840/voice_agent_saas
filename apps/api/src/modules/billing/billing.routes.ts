import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { ENTITLEMENT_ENFORCEMENT } from "./plan-types.js";
import { billingService, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./billing.service.js";

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  includeSuperseded: z.enum(["true", "false"]).optional(),
});

// .strict(): unknown properties (e.g. organizationId, status, role) are rejected, never silently applied.
const planChangeBody = z.object({ planKey: z.string().trim().min(1).max(40) }).strict();
const emptyBody = z.object({}).strict();

/** Billing endpoints. Tenant identity is the authenticated membership (req.ctx); no route accepts an organization id. */
export async function billingRoutes(app: FastifyInstance) {
  app.get("/api/billing/plans", async (req, reply) => {
    return reply.send({ data: await billingService.listPlans(requireContext(req)), meta: { entitlementEnforcement: ENTITLEMENT_ENFORCEMENT } });
  });

  app.get("/api/billing/overview", async (req, reply) => {
    return reply.send({ data: await billingService.overview(requireContext(req)) });
  });

  app.get("/api/billing/usage", async (req, reply) => {
    const q = parseInput(historyQuery, req.query);
    const result = await billingService.usageHistory(requireContext(req), {
      limit: q.limit,
      cursor: q.cursor,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      includeSuperseded: q.includeSuperseded === "true",
    });
    return reply.send(result);
  });

  app.post("/api/billing/trial", async (req, reply) => {
    parseInput(emptyBody, req.body);
    return reply.status(201).send({ data: await billingService.startTrial(requireContext(req)) });
  });

  app.post("/api/billing/plan-change", async (req, reply) => {
    const body = parseInput(planChangeBody, req.body);
    return reply.send({ data: await billingService.requestPlanChange(requireContext(req), body) });
  });

  app.post("/api/billing/cancel", async (req, reply) => {
    parseInput(emptyBody, req.body);
    return reply.send({ data: await billingService.cancel(requireContext(req)) });
  });

  app.post("/api/billing/resume", async (req, reply) => {
    parseInput(emptyBody, req.body);
    return reply.send({ data: await billingService.resume(requireContext(req)) });
  });

  // Meters ended calls that are not in the ledger yet. Takes no input: durations come from our own call records.
  app.post("/api/billing/usage/reconcile", async (req, reply) => {
    parseInput(emptyBody, req.body);
    return reply.send({ data: await billingService.reconcileUsage(requireContext(req)) });
  });
}
