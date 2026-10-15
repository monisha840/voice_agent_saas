/**
 * Authorization helpers used by the service layer.
 *
 *  - assertCan(ctx, permission): the role-level check (permission matrix), plus the module check: a permission
 *    provided by an optional module is only usable while the caller's organization has that module enabled.
 *  - leadScopeFor / projectScopeFor: the data-level check — which projects and leads this particular user may
 *    touch. Repositories apply the scope in SQL, so an out-of-scope record behaves exactly like a non-existent one.
 *    The core knows no leads or projects: the Sales module registers the scope providers (registerScopeProvider);
 *    without one the core falls back to the conservative defaults below.
 *
 * System actors (the Exotel webhook, the media-stream socket, AI tool calls,
 * the reaper) are not users: they are trusted internal flows that are already
 * confined to one organization, so they pass every permission and see the
 * whole organization.
 */
import { runInTenant } from "../db/tenant-context.js";
import { scopeOf } from "./tenant-scoped.js";
import { ForbiddenError } from "../shared/errors.js";
import type { RequestContext } from "./context.js";
import { moduleOfPermission, roleHasPermission, type Permission } from "./permissions.js";
import type { LeadScope, ProjectScope } from "./scope.js";
import { MODULES } from "../modules/modules/module-registry.js";

/** True when the permission belongs to a module the caller's organization has not enabled (and we know which are enabled). */
function moduleBlocks(ctx: RequestContext, permission: Permission): string | null {
  const module = moduleOfPermission(permission);
  if (!module || !ctx.enabledModules) return null;
  return ctx.enabledModules.includes(module) ? null : module;
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  if (ctx.actor.type === "system") return true;
  return roleHasPermission(ctx.actor.role, permission) && moduleBlocks(ctx, permission) === null;
}

export function assertCan(ctx: RequestContext, permission: Permission): void {
  if (ctx.actor.type === "system") return;
  if (!roleHasPermission(ctx.actor.role, permission)) {
    throw new ForbiddenError(`Your role does not allow this action (${permission})`);
  }
  const blocked = moduleBlocks(ctx, permission);
  if (blocked) {
    const label = MODULES.find((m) => m.key === blocked)?.label ?? blocked;
    throw new ForbiddenError(`The ${label} module is not enabled for this organization`);
  }
}

// ---------------------------------------------------------------------------
// Data-level scope: pluggable, with conservative core defaults
// ---------------------------------------------------------------------------

/** How a module narrows what a user may see. A provider handles USER contexts only (system actors always see everything). */
export interface ScopeProvider {
  lead?(ctx: RequestContext): Promise<LeadScope>;
  project?(ctx: RequestContext): Promise<ProjectScope>;
}

const scopeProviders = new Map<string, ScopeProvider>();

/** Idempotent per module. */
export function registerScopeProvider(module: string, provider: ScopeProvider): void {
  scopeProviders.set(module, provider);
}

export function unregisterScopeProvider(module: string): void {
  scopeProviders.delete(module);
}

/**
 * Core default when no module defines lead visibility: owners and admins see every call, managers see the calls
 * that have no lead, agents see the calls they started themselves. Nothing refers to a lead that does not exist.
 */
function defaultLeadScope(ctx: RequestContext & { actor: { type: "user" } }): LeadScope {
  switch (ctx.actor.role) {
    case "OWNER":
    case "ADMIN":
      return { kind: "all" };
    case "MANAGER":
      return { kind: "projects", projectIds: [] };
    case "AGENT":
      return { kind: "assigned", userId: ctx.actor.userId };
  }
}

/** Core default when no module defines project visibility: owners and admins see all, everyone else none. */
function defaultProjectScope(ctx: RequestContext & { actor: { type: "user" } }): ProjectScope {
  return ctx.actor.role === "OWNER" || ctx.actor.role === "ADMIN" ? { kind: "all" } : { kind: "ids", projectIds: [] };
}

export async function leadScopeFor(ctx: RequestContext): Promise<LeadScope> {
  if (ctx.actor.type === "system") return { kind: "all" };
  return runInTenant(scopeOf(ctx), async () => {
    for (const p of scopeProviders.values()) if (p.lead) return p.lead(ctx);
    return defaultLeadScope(ctx as RequestContext & { actor: { type: "user" } });
  });
}

export async function projectScopeFor(ctx: RequestContext): Promise<ProjectScope> {
  if (ctx.actor.type === "system") return { kind: "all" };
  return runInTenant(scopeOf(ctx), async () => {
    for (const p of scopeProviders.values()) if (p.project) return p.project(ctx);
    return defaultProjectScope(ctx as RequestContext & { actor: { type: "user" } });
  });
}
