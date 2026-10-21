/**
 * Registers the HTTP routes of every registered module. Each module's routes live in their own encapsulated scope
 * with a gate in front: a logged-in user of an organization that has not enabled the module gets 403 before any
 * module route runs (system flows never come through here). A module that is not registered contributes no routes at
 * all, so its URLs simply do not exist.
 */
import type { FastifyInstance } from "fastify";
import { requireModule } from "./modules.routes.js";
import { MODULES, type ModuleKey } from "./module-registry.js";
import { registeredModules } from "./module-runtime.js";

export async function registerModuleRoutes(app: FastifyInstance): Promise<void> {
  for (const manifest of registeredModules()) {
    if (!manifest.routes?.length) continue;
    if (!MODULES.some((m) => m.key === manifest.key)) {
      throw new Error(`Module "${manifest.key}" has routes but is not in the module catalogue (modules/modules/module-registry.ts)`);
    }
    await app.register(async (scope) => {
      scope.addHook("preHandler", requireModule(manifest.key as ModuleKey));
      for (const plugin of manifest.routes ?? []) await scope.register(plugin);
    });
  }
}
