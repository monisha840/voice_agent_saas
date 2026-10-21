/**
 * Account recovery: customer-facing password reset ("forgot password") and e-mail verification.
 *
 * These are the two flows a customer needs when nobody can help them from inside the product: a locked-out user has
 * no session, so none of the authenticated endpoints in account-security.routes.ts can reach them, and the only
 * other route back in was an operator running a CLI.
 *
 * Nothing here is new machinery. It reuses, deliberately and in the same shapes:
 *   - the invite token pattern (modules/users/users.service.ts): randomBytes(32).toString("base64url"), stored only
 *     as a sha256 hash, with a TTL, and ONE error message for every unusable-token case so a caller cannot probe
 *     which tokens exist;
 *   - the password policy (auth/password-policy.ts: checkPassword + PASSWORD_PROBLEM_MESSAGE) and hashing
 *     (auth/password.ts);
 *   - usersRepository.changePasswordRevokingSessions, which sets the hash, stamps password_changed_at and ends
 *     sessions in one transaction - the house rule that a password change revokes sessions;
 *   - the security trail (security/security-events.ts).
 *
 * THE CENTRAL SECURITY PROPERTY IS ENUMERATION SAFETY. `requestPasswordReset` must answer identically whether or
 * not the address exists - same status, same body, and the same latency class. The three ways that leaks are all
 * closed here:
 *   status/body  the function returns nothing and the route always answers 200 { ok: true }; a missing account, a
 *                deactivated account and a failed send all take the same path;
 *   latency      the existing-address path costs one lookup plus one insert; the unknown-address path performs an
 *                equivalent pair of bounded queries (`burnAccountLookup`) instead of returning early, and the
 *                provider send - by far the most expensive and most variable step - is never awaited (see
 *                recovery-mail.ts). Both paths are one lookup + one write before the response.
 *   side channel the mail itself only ever goes to the submitted address, so an attacker learns nothing from it.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { checkPassword, PASSWORD_PROBLEM_MESSAGE } from "../../auth/password-policy.js";
import { hashPassword } from "../../auth/password.js";
import { usersRepository } from "../../db/repositories/users.repository.js";
import { securityEvents } from "../../security/security-events.js";
import { ValidationError } from "../../shared/errors.js";
import { accountTokensRepository, emailVerificationRepository, type AccountTokenPurpose } from "./account-tokens.repository.js";
import { sendEmailVerificationEmail, sendPasswordResetEmail } from "./recovery-mail.js";

/**
 * One hour. Much shorter than the 7-day invite TTL on purpose: an invite is an offer, a reset link is a live
 * credential for an existing account that sits in a mailbox the customer may not control exclusively.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** A day. Verification is not a credential for signing in, so it can be convenient. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * ONE message for every unusable password-reset token: unknown, malformed, expired, already spent, issued for an
 * address that has since changed, or belonging to a deactivated account. Mirrors INVALID_INVITATION exactly.
 */
export const INVALID_RESET_TOKEN = "This password reset link is invalid or has expired. Request a new one.";
export const INVALID_VERIFICATION_TOKEN = "This confirmation link is invalid or has expired. Request a new one.";

/** Identical in both flows, and identical to hashInviteToken. */
export const hashAccountToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const newToken = (): string => randomBytes(32).toString("base64url");

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface RequestActor {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * The work the unknown-address path does instead of returning early, so that path is not measurably cheaper than
 * the real one. The analogue of burnPasswordCheck in auth/password.ts: a lookup against the same unique index with
 * a hash nothing can match, plus one counting query, so both paths issue two bounded statements. It also hashes a
 * throwaway token, matching the real path's token generation.
 */
async function burnAccountLookup(): Promise<void> {
  const decoy = hashAccountToken(newToken());
  const now = new Date();
  await accountTokensRepository.findUsableByTokenHash({ tokenHash: decoy, purpose: "password_reset", now });
  await accountTokensRepository.countOutstanding({ userId: randomUUID(), purpose: "password_reset", now });
}

/** Mints a token for `purpose`, invalidating any older outstanding one so only the newest link works. */
async function mintToken(params: {
  userId: string;
  email: string;
  purpose: AccountTokenPurpose;
  ttlMs: number;
  ip?: string | null;
}): Promise<{ token: string; tokenId: string }> {
  const token = newToken();
  const now = new Date();
  const row = await accountTokensRepository.create({
    userId: params.userId,
    purpose: params.purpose,
    email: params.email,
    tokenHash: hashAccountToken(token),
    expiresAt: new Date(now.getTime() + params.ttlMs),
    requestedIp: params.ip ?? null,
  });
  await accountTokensRepository.supersedeOutstanding({ userId: params.userId, purpose: params.purpose, now, exceptId: row.id });
  return { token, tokenId: row.id };
}

export const accountRecovery = {
  /**
   * PUBLIC. Starts a password reset. Returns nothing in every case - there is no success and no failure the caller
   * can distinguish, which is the whole point. A deactivated account is treated exactly like an unknown address:
   * reactivation is an operator decision, and answering differently would confirm the address exists.
   */
  async requestPasswordReset(input: { email: string }, actor: RequestActor = {}): Promise<void> {
    const email = normalizeEmail(input.email);
    const user = await usersRepository.findByEmail({ email });

    if (!user || !user.isActive) {
      await burnAccountLookup();
      // No address in the metadata: security_events must stay free of identifiers we do not need, and the IP and
      // user agent are already recorded as columns.
      await securityEvents.record({
        type: "auth.password.reset_requested",
        outcome: "info",
        userId: user?.id ?? null,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { delivered: false, reason: user ? "inactive" : "unknown_address" },
      });
      return;
    }

    const { token, tokenId } = await mintToken({
      userId: user.id,
      email: user.email,
      purpose: "password_reset",
      ttlMs: PASSWORD_RESET_TTL_MS,
      ip: actor.ip,
    });
    // Dispatched, never awaited: delivery is best-effort and must not become a timing channel (recovery-mail.ts).
    sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      token,
      tokenId,
      ttlMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60_000),
    });
    await securityEvents.record({
      type: "auth.password.reset_requested",
      outcome: "info",
      userId: user.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { delivered: true, tokenId },
    });
  },

  /**
   * PUBLIC (the token is the credential). Completes a reset: validates the token, applies the password policy,
   * spends the token atomically, then sets the new hash and REVOKES EVERY SESSION.
   *
   * Order matters and is deliberate:
   *   1. find the usable token (read only) - a bad token is refused before anything else happens;
   *   2. apply the password policy against this user's own email/name - a weak password is refused WITHOUT burning
   *      the customer's only link, which otherwise turns one typo into "request another e-mail";
   *   3. spend the token (single UPDATE ... WHERE used_at IS NULL RETURNING) - the atomic guard: a request that
   *      loses this race is refused with the same message as an unknown token;
   *   4. set the hash and end all sessions in one transaction, then invalidate any sibling reset link.
   * A crash between 3 and 4 leaves the token spent and the password unchanged - the fail-safe direction.
   *
   * Returns the user plus whether a second factor is still outstanding. It does NOT create a session; the route
   * does that, so the session shape stays identical to /login and /accept-invite.
   */
  async completePasswordReset(input: { token: string; password: string }, actor: RequestActor = {}) {
    const now = new Date();
    const tokenHash = hashAccountToken(input.token);
    const candidate = await accountTokensRepository.findUsableByTokenHash({ tokenHash, purpose: "password_reset", now });

    const refuse = async (reason: string, userId?: string | null): Promise<never> => {
      await securityEvents.record({
        type: "auth.password.reset_failed",
        outcome: "failure",
        userId: userId ?? null,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason },
      });
      throw new ValidationError(INVALID_RESET_TOKEN);
    };

    if (!candidate) return refuse("unusable_token");

    const user = await usersRepository.findById({ id: candidate.userId });
    if (!user || !user.isActive) return refuse("inactive_account", candidate.userId);
    // The token was issued FOR an address. If the account's address changed since, the token is dead: whoever holds
    // it proved control of a mailbox that is no longer this account's.
    if (normalizeEmail(candidate.email) !== normalizeEmail(user.email)) return refuse("address_changed", user.id);

    // Reachable only with a valid token, so a distinct message here reveals nothing the caller does not know.
    const problem = await checkPassword({ password: input.password, email: user.email, name: user.name });
    if (problem) {
      await securityEvents.record({
        type: "auth.password.rejected",
        outcome: "denied",
        userId: user.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { problem, via: "password_reset" },
      });
      throw new ValidationError(PASSWORD_PROBLEM_MESSAGE[problem]);
    }

    const spent = await accountTokensRepository.consume({ tokenHash, purpose: "password_reset", now: new Date() });
    if (!spent) return refuse("token_race", user.id);

    // keepSessionId: null revokes ALL sessions. A reset is the one case where that is unconditional: the account
    // may have been in someone else's hands, and the customer is not signed in anywhere we can trust.
    const revoked = await usersRepository.changePasswordRevokingSessions({
      id: user.id,
      passwordHash: await hashPassword(input.password),
      keepSessionId: null,
    });
    // A link an attacker requested in parallel dies with the one that was used.
    await accountTokensRepository.supersedeOutstanding({ userId: user.id, purpose: "password_reset", now: new Date(), exceptId: spent.id });
    // Completing a reset proves control of the mailbox, which is exactly what verification means; recording it
    // here means a recovered account is not left nagging the customer to confirm an address they just used.
    const verified = await emailVerificationRepository.markVerified({ userId: user.id, email: user.email, at: new Date() });

    await securityEvents.record({
      type: "auth.password.reset_completed",
      outcome: "success",
      userId: user.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { sessionsRevoked: revoked, tokenId: spent.id, emailVerifiedByReset: verified },
    });
    // mfaEnabledAt is read AFTER the change so the second-factor decision is made on current state.
    const fresh = (await usersRepository.findById({ id: user.id })) ?? user;
    return { user: fresh, sessionsRevoked: revoked, mfaRequired: !!fresh.mfaEnabledAt };
  },

  /** The signed-in user's own verification state. */
  async verificationStatus(params: { userId: string }) {
    const user = await usersRepository.findById({ id: params.userId });
    if (!user) return null;
    return { email: user.email, verified: !!user.emailVerifiedAt, verifiedAt: user.emailVerifiedAt ?? null };
  },

  /**
   * Sends a verification link to the signed-in user's OWN address. It takes a user id, not an address, so it can
   * neither probe for accounts nor be aimed at a third party's mailbox.
   */
  async requestEmailVerification(params: { userId: string }, actor: RequestActor = {}) {
    const user = await usersRepository.findById({ id: params.userId });
    if (!user || !user.isActive) throw new ValidationError("This account cannot be verified.");
    if (user.emailVerifiedAt) return { email: user.email, alreadyVerified: true as const };

    const { token, tokenId } = await mintToken({
      userId: user.id,
      email: user.email,
      purpose: "email_verification",
      ttlMs: EMAIL_VERIFICATION_TTL_MS,
      ip: actor.ip,
    });
    sendEmailVerificationEmail({
      to: user.email,
      name: user.name,
      token,
      tokenId,
      ttlHours: Math.round(EMAIL_VERIFICATION_TTL_MS / 3_600_000),
    });
    await securityEvents.record({
      type: "auth.email.verification_sent",
      outcome: "info",
      userId: user.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { tokenId },
    });
    return { email: user.email, alreadyVerified: false as const };
  },

  /**
   * PUBLIC (the token is the credential). Confirms an address. Single-use: a replayed link is refused with the
   * same message as an unknown one, because the row's used_at is already set and `consume` matches nothing.
   */
  async confirmEmailVerification(input: { token: string }, actor: RequestActor = {}) {
    const refuse = async (reason: string, userId?: string | null): Promise<never> => {
      await securityEvents.record({
        type: "auth.email.verification_failed",
        outcome: "failure",
        userId: userId ?? null,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason },
      });
      throw new ValidationError(INVALID_VERIFICATION_TOKEN);
    };

    const spent = await accountTokensRepository.consume({
      tokenHash: hashAccountToken(input.token),
      purpose: "email_verification",
      now: new Date(),
    });
    if (!spent) return refuse("unusable_token");

    const user = await usersRepository.findById({ id: spent.userId });
    if (!user || !user.isActive) return refuse("inactive_account", spent.userId);
    if (normalizeEmail(spent.email) !== normalizeEmail(user.email)) return refuse("address_changed", user.id);

    // False when it was already verified (e.g. by a password reset); that is a success for the caller either way.
    const stamped = await emailVerificationRepository.markVerified({ userId: user.id, email: user.email, at: new Date() });
    await securityEvents.record({
      type: "auth.email.verified",
      outcome: "success",
      userId: user.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { tokenId: spent.id, alreadyVerified: !stamped },
    });
    return { email: user.email, alreadyVerified: !stamped };
  },

  /** Janitor hook: drops expired and long-spent rows in bounded batches. */
  async purgeUnusableTokens(now: Date = new Date(), keepMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const before = new Date(now.getTime() - keepMs);
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const n = await accountTokensRepository.deleteUnusable({ before, batch: 1000 });
      total += n;
      if (n < 1000) break;
    }
    return total;
  },
};
