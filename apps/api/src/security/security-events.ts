/**
 * Authentication and security audit trail (security_events). Distinct from the per-tenant business audit log: it
 * covers things that happen before a tenant is known (a failed login), account-level events (MFA, sessions) and
 * security decisions (denied cross-tenant access, privileged system actions).
 *
 * Rules: only identifiers and outcomes are stored - never a password, token, TOTP code, recovery code, session
 * cookie, API secret or request body. Metadata is run through the same redaction as the business audit log.
 * Recording never throws into the login path, but a failure to persist is NOT silent: the complete event (already
 * redacted) is written to the error log so it can be recovered.
 */
import { securityEventsRepository } from "../db/repositories/security.repository.js";
import { runInTenant } from "../db/tenant-context.js";
import { sanitizeMetadata } from "../modules/audit/audit.service.js";
import { currentRequestId } from "../runtime/request-context.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../runtime/metrics.js";

export type SecurityEventType =
  | "auth.login.success"
  | "auth.login.failed"
  | "auth.login.throttled"
  | "auth.login.mfa_required"
  | "auth.logout"
  | "auth.password.changed"
  | "auth.password.rejected"
  | "auth.reauthenticated"
  | "auth.reauthentication.failed"
  | "auth.mfa.enrollment_started"
  | "auth.mfa.enrolled"
  | "auth.mfa.verified"
  | "auth.mfa.failed"
  | "auth.mfa.throttled"
  | "auth.mfa.replay_rejected"
  | "auth.mfa.disabled"
  | "auth.mfa.recovery_code_used"
  | "auth.mfa.recovery_codes_regenerated"
  | "auth.mfa.reset_by_operator"
  | "auth.account.deactivated"
  | "session.created"
  | "session.revoked"
  | "session.revoked_others"
  | "session.revoked_by_policy"
  | "access.tenant_denied"
  | "access.role_denied"
  | "access.stream_denied"
  | "system.privileged_action"
  | "membership.role_changed"
  | "membership.removed";

export interface SecurityEventInput {
  type: SecurityEventType;
  outcome: "success" | "failure" | "denied" | "info";
  userId?: string | null;
  organizationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export const securityEvents = {
  async record(event: SecurityEventInput): Promise<void> {
    // Counted before persistence so throttle pressure stays visible while the database write path is failing.
    if (event.type === "auth.login.throttled") metrics.inc("auth_throttle_denied_total", { kind: "login" });
    else if (event.type === "auth.mfa.throttled") metrics.inc("auth_throttle_denied_total", { kind: "mfa" });
    const row = {
      organizationId: event.organizationId ?? null,
      actorUserId: event.userId ?? null,
      eventType: event.type,
      outcome: event.outcome,
      ipAddress: event.ip?.slice(0, 64) ?? null,
      userAgent: event.userAgent?.slice(0, 256) ?? null,
      requestId: currentRequestId()?.slice(0, 64) ?? null,
      metadata: sanitizeMetadata(event.metadata ?? {}) as Record<string, unknown>,
    };
    try {
      // Rows are written under the scope of the organization they belong to (or no scope for account-level events).
      if (row.organizationId) await runInTenant({ organizationId: row.organizationId }, async () => securityEventsRepository.insert(row));
      else await securityEventsRepository.insert(row);
    } catch (err) {
      metrics.inc("security_event_persist_failures_total");
      logger.error("security-events: FAILED TO PERSIST (event preserved here)", {
        ...row,
        persistError: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
