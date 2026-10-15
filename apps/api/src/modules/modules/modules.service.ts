import { runInTenant } from "../../db/tenant-context.js";
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { organizationModulesRepository } from "../../db/repositories/organization-modules.repository.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { MODULES, getModule, isModuleKey, type ModuleKey } from "./module-registry.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

export interface OrganizationModuleState {
  key: ModuleKey;
  label: string;
  description: string;
  enabled: boolean;
}

const modulesServiceImpl = {
  /** Every module in the catalogue with this organization's state (no row = disabled). */
  async list(ctx: RequestContext): Promise<OrganizationModuleState[]> {
    assertCan(ctx, "org:read");
    const enabled = new Set(await organizationModulesRepository.listEnabledKeys({ organizationId: ctx.organizationId }));
    return MODULES.map((m) => ({ key: m.key, label: m.label, description: m.description, enabled: enabled.has(m.key) }));
  },

  /** Keys of the modules this organization has switched on (for the /auth/me payload). */
  async enabledKeys(params: { organizationId: string }): Promise<ModuleKey[]> {
    // Takes an organization id from trusted callers (their verified context); scope the read to it.
    const keys = await runInTenant({ organizationId: params.organizationId }, async () =>
      organizationModulesRepository.listEnabledKeys(params),
    );
    return keys.filter(isModuleKey);
  },

  /**
   * Gate for USER-initiated requests to a module's features. System flows
   * (media-stream, AI tools, webhook, reaper) always pass: they act on records
   * that already exist, so switching a module off never breaks a call that is
   * in progress or its post-call processing.
   */
  async assertEnabled(ctx: RequestContext, moduleKey: ModuleKey): Promise<void> {
    if (ctx.actor.type === "system") return;
    if (await organizationModulesRepository.isEnabled({ organizationId: ctx.organizationId, moduleKey })) return;
    throw new ForbiddenError(`The ${getModule(moduleKey).label} module is not enabled for this organization`);
  },

  /** Enables or disables a module. Only switches the feature; the module's data is never deleted. */
  async setEnabled(ctx: RequestContext, params: { moduleKey: string; enabled: boolean }): Promise<OrganizationModuleState> {
    assertCan(ctx, "org:manage");
    if (!isModuleKey(params.moduleKey)) throw new NotFoundError(`Unknown module "${params.moduleKey}"`);
    if (typeof params.enabled !== "boolean") throw new ValidationError("enabled must be true or false");
    const moduleKey = params.moduleKey;
    const wasEnabled = await organizationModulesRepository.isEnabled({ organizationId: ctx.organizationId, moduleKey });
    await organizationModulesRepository.setEnabled({ organizationId: ctx.organizationId, moduleKey, enabled: params.enabled });
    if (wasEnabled !== params.enabled) {
      await auditService.record(ctx, {
        action: "org.module_updated",
        entityType: "organization",
        entityId: ctx.organizationId,
        metadata: { module: moduleKey, enabled: params.enabled },
      });
    }
    const def = getModule(moduleKey);
    return { key: moduleKey, label: def.label, description: def.description, enabled: params.enabled };
  },
};

export const modulesService = tenantScoped(modulesServiceImpl);
