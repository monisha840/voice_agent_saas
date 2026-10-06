import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { agentPhoneNumbersService } from "./agent-phone-numbers.service.js";

const agentParams = z.object({ id: z.string().uuid() });
const numberParams = z.object({ id: z.string().uuid(), numberId: z.string().uuid() });
const addBody = z.object({ phoneNumber: z.string().trim().min(3).max(32), label: z.string().trim().max(100).nullable().optional() }).strict();

export async function agentPhoneNumbersRoutes(app: FastifyInstance) {
  app.get("/api/agents/:id/phone-numbers", async (req, reply) => {
    const { id } = parseInput(agentParams, req.params);
    return reply.send({ data: await agentPhoneNumbersService.list(requireContext(req), { agentId: id }) });
  });

  app.post("/api/agents/:id/phone-numbers", async (req, reply) => {
    const { id } = parseInput(agentParams, req.params);
    const body = parseInput(addBody, req.body);
    return reply.status(201).send({ data: await agentPhoneNumbersService.add(requireContext(req), { agentId: id, ...body }) });
  });

  app.delete("/api/agents/:id/phone-numbers/:numberId", async (req, reply) => {
    const { id, numberId } = parseInput(numberParams, req.params);
    await agentPhoneNumbersService.remove(requireContext(req), { agentId: id, id: numberId });
    return reply.status(204).send();
  });
}
