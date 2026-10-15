/**
 * Binds database access to the organization of the RequestContext a service method receives.
 *
 * Services take a verified RequestContext as their first argument (see context.ts). Wrapping a service with
 * tenantScoped() runs every method that receives one inside that context's tenant scope, so the database client sets
 * the row-level-security tenant for every statement the method issues - from HTTP routes, the media stream, provider
 * webhooks, AI tools and the reaper alike. A method called without a context runs unscoped and sees no tenant rows.
 */
import { runInTenant } from "../db/tenant-context.js";
import type { RequestContext } from "./context.js";

function isRequestContext(value: unknown): value is RequestContext {
  if (!value || typeof value !== "object") return false;
  const v = value as { organizationId?: unknown; actor?: unknown };
  return typeof v.organizationId === "string" && !!v.actor && typeof v.actor === "object";
}

export function scopeOf(ctx: RequestContext) {
  return { organizationId: ctx.organizationId, ...(ctx.actor.type === "user" ? { userId: ctx.actor.userId } : {}) };
}

const MARKER = Symbol.for("voice-agent.tenantScoped");

/** True for objects produced by tenantScoped (used by the security guardrail tests). */
export function isTenantScoped(service: object): boolean {
  return (service as Record<symbol, unknown>)[MARKER] === true;
}

export function tenantScoped<T extends object>(service: T): T {
  const scoped: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(service)) {
    if (typeof member !== "function") {
      scoped[key] = member;
      continue;
    }
    scoped[key] = function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      if (!isRequestContext(first)) return (member as (...a: unknown[]) => unknown).apply(this, args);
      return runInTenant(scopeOf(first), () => (member as (...a: unknown[]) => unknown).apply(this, args));
    };
  }
  Object.defineProperty(scoped, MARKER, { value: true, enumerable: false });
  return scoped as T;
}
