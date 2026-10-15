/**
 * Audit logging for important actions. Call `auditService.record(ctx, ...)`
 * from the SERVICE layer right after a successful state change, e.g.:
 *
 *   await auditService.record(ctx, {
 *     action: "project.created", entityType: "project", entityId: project.id,
 *     metadata: { name: project.name },
 *   });
 *
 * Conventions: `action` is "<entity>.<verb>" (project.created, lead.updated,
 * user.role_changed, call.initiated, site_visit.booked, agent_config.updated).
 * The record carries the organization and the actor (user, or the system flow)
 * from the request context. Metadata is sanitized: secrets are stripped before
 * anything is written, and recording never throws — a logging failure must not
 * fail the business action it describes.
 */
import { auditRepository } from "../../db/repositories/audit.repository.js";
import type { RequestContext } from "../../auth/context.js";
import { assertCan } from "../../auth/access.js";
import { logger, scrubString } from "../../shared/logger.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

const SECRET_KEY = /pass(word)?|token|secret|hash|authorization|cookie|api[-_]?key|credential|grant(?!ed)|^st$|^g$/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

/** Removes secret-looking keys, truncates long strings, bounds depth. Pure and exported for tests. */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  // Scrubbed BEFORE truncation so a credential cut in half is not left behind; URLs/headers pasted into a value are masked.
  if (typeof value === "string") {
    const clean = scrubString(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

const auditServiceImpl = {
  async record(ctx: RequestContext, event: AuditEvent): Promise<void> {
    try {
      await auditRepository.insert({
        organizationId: ctx.organizationId,
        actorType: ctx.actor.type,
        actorUserId: ctx.actor.type === "user" ? ctx.actor.userId : null,
        actorSource: ctx.actor.type === "system" ? ctx.actor.source : null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        metadata: sanitizeMetadata(event.metadata ?? {}) as Record<string, unknown>,
        ipAddress: event.ipAddress?.slice(0, 64) ?? null,
      });
    } catch (err) {
      logger.error("audit: failed to record event", {
        action: event.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Newest first; the cursor is the createdAt of the last row (pass it back as `before`). */
  async list(
    ctx: RequestContext,
    params: { limit: number; before?: Date; action?: string; entityType?: string; entityId?: string },
  ) {
    assertCan(ctx, "audit:read");
    const rows = await auditRepository.list({ organizationId: ctx.organizationId, ...params, limit: params.limit + 1 });
    const data = rows.slice(0, params.limit);
    const hasMore = rows.length > params.limit;
    return { data, nextBefore: hasMore ? data[data.length - 1].createdAt.toISOString() : null };
  },
};

export const auditService = tenantScoped(auditServiceImpl);
