import type { FastifyInstance } from "fastify";
import { requireContext } from "../../auth/auth.plugin.js";
import { assertCan } from "../../auth/access.js";
import { getToolCatalog } from "../../ai-tools/index.js";
import { modulesService } from "../modules/modules.service.js";

export async function toolsRoutes(app: FastifyInstance) {
  /** The tool catalogue, with whether each tool is usable by the caller's organization. */
  app.get("/api/tools", async (req, reply) => {
    const ctx = requireContext(req);
    assertCan(ctx, "agents:read");
    const enabled = new Set<string>(await modulesService.enabledKeys({ organizationId: ctx.organizationId }));
    const data = getToolCatalog().map((t) => ({ ...t, available: t.module === "core" || enabled.has(t.module) }));
    return reply.send({ data });
  });
}
