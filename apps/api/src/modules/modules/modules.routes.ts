import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import type { ModuleKey } from "./module-registry.js";
import { modulesService } from "./modules.service.js";

const keyParams = z.object({ key: z.string().min(1).max(50) });
const enabledBody = z.object({ enabled: z.boolean() });

/**
 * Plugin-level gate: `app.addHook("preHandler", requireModule("sales"))` makes every route in
 * that plugin return 403 for users in an organization that has the module switched off.
 */
export function requireModule(moduleKey: ModuleKey) {
  return async (req: FastifyRequest) => {
    await modulesService.assertEnabled(requireContext(req), moduleKey);
  };
}

export async function modulesRoutes(app: FastifyInstance) {
  app.get("/api/organization/modules", async (req, reply) => {
    return reply.send({ data: await modulesService.list(requireContext(req)) });
  });

  app.put("/api/organization/modules/:key", async (req, reply) => {
    const { key } = parseInput(keyParams, req.params);
    const { enabled } = parseInput(enabledBody, req.body);
    return reply.send({ data: await modulesService.setEnabled(requireContext(req), { moduleKey: key, enabled }) });
  });
}
