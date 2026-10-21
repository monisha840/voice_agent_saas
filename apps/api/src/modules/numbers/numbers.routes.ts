import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { numbersService } from "./numbers.service.js";

const idParams = z.object({ id: z.string().uuid() });
const addBody = z
  .object({
    phoneNumber: z.string().trim().min(3).max(32),
    agentId: z.string().uuid(),
    label: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
const updateBody = z
  .object({
    label: z.string().trim().max(100).nullable().optional(),
    agentId: z.string().uuid().optional(),
    routingEnabled: z.boolean().optional(),
    expectedAgentId: z.string().uuid().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
const removeQuery = z.object({ confirm: z.enum(["true", "false"]).optional() }).strict();

/** Telephony number management (modules/numbers/numbers.service.ts). The organization always comes from the login. */
export async function numbersRoutes(app: FastifyInstance) {
  app.get("/api/numbers", async (req, reply) => {
    return reply.send({ data: await numbersService.list(requireContext(req)) });
  });

  app.post("/api/numbers", async (req, reply) => {
    const body = parseInput(addBody, req.body);
    return reply.status(201).send({ data: await numbersService.add(requireContext(req), body) });
  });

  app.get("/api/numbers/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    return reply.send({ data: await numbersService.get(requireContext(req), { id }) });
  });

  app.patch("/api/numbers/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(updateBody, req.body);
    return reply.send({ data: await numbersService.update(requireContext(req), { id, ...body }) });
  });

  app.delete("/api/numbers/:id", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const { confirm } = parseInput(removeQuery, req.query ?? {});
    await numbersService.remove(requireContext(req), { id, confirm: confirm === "true" });
    return reply.status(204).send();
  });

  app.post("/api/numbers/:id/check", async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    return reply.send({ data: await numbersService.diagnose(requireContext(req), { id }) });
  });
}
