import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { organizationsRepository } from "../../db/repositories/organizations.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

const organizationsServiceImpl = {
  async get(ctx: RequestContext) {
    assertCan(ctx, "org:read");
    const org = await organizationsRepository.findById({ id: ctx.organizationId });
    if (!org) throw new NotFoundError("Organization not found");
    return { id: org.id, name: org.name, slug: org.slug, role: ctx.actor.type === "user" ? ctx.actor.role : null };
  },

  async rename(ctx: RequestContext, input: { name: string }) {
    assertCan(ctx, "org:manage");
    const before = await organizationsRepository.findById({ id: ctx.organizationId });
    const org = await organizationsRepository.rename({ id: ctx.organizationId, name: input.name });
    if (!before || !org) throw new NotFoundError("Organization not found");
    await auditService.record(ctx, {
      action: "org.updated",
      entityType: "organization",
      entityId: org.id,
      metadata: { from: before.name, to: org.name },
    });
    return { id: org.id, name: org.name, slug: org.slug, role: ctx.actor.type === "user" ? ctx.actor.role : null };
  },
};

export const organizationsService = tenantScoped(organizationsServiceImpl);
