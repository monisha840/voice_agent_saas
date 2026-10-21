/**
 * Account-level administrative actions that are NOT available to tenant users: deactivating an account and
 * resetting a lost second factor. They are operator actions (see scripts/user-admin.ts, run with the administrative
 * database connection), not API endpoints, so no request an attacker can make reaches them.
 *
 * Both end every session of the account in the same transaction as the change and leave a security event naming
 * the operator. Resetting MFA removes the factor and the recovery codes; the user signs in with their password and,
 * if their role requires MFA, is held at enrolment until they set up a new device. It never creates a bypass.
 */
import { usersRepository } from "../db/repositories/users.repository.js";
import { mfaRecoveryCodesRepository } from "../db/repositories/security.repository.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";
import { securityEvents } from "../security/security-events.js";
import { NotFoundError } from "../shared/errors.js";

export const accountService = {
  async deactivate(params: { userId: string; operator: string; reason?: string }) {
    const user = await usersRepository.findById({ id: params.userId });
    if (!user) throw new NotFoundError("User not found");
    const revoked = await usersRepository.deactivateRevokingSessions({ id: user.id });
    await securityEvents.record({
      type: "auth.account.deactivated",
      outcome: "success",
      userId: user.id,
      metadata: { operator: params.operator, reason: params.reason ?? null, sessionsRevoked: revoked },
    });
    return { sessionsRevoked: revoked };
  },

  async resetMfa(params: { userId: string; operator: string; reason?: string }) {
    const user = await usersRepository.findById({ id: params.userId });
    if (!user) throw new NotFoundError("User not found");
    await usersRepository.clearMfa({ id: user.id });
    await mfaRecoveryCodesRepository.deleteAll({ userId: user.id });
    await sessionsRepository.deleteAllForUser({ userId: user.id });
    await securityEvents.record({
      type: "auth.mfa.reset_by_operator",
      outcome: "success",
      userId: user.id,
      metadata: { operator: params.operator, reason: params.reason ?? null },
    });
  },
};
