/**
 * TOTP multi-factor authentication: enrolment, login verification, recovery codes, disabling.
 *
 * Invariants:
 *  - The seed is generated server-side (160 random bits), sealed with AES-256-GCM before it touches the database,
 *    bound to the user id, and never returned again after enrolment.
 *  - Enrolment is two-step: a pending seed does nothing until a valid code proves the authenticator works. A
 *    confirmed account cannot be re-enrolled over (an attacker with a session cannot swap the factor).
 *  - A TOTP step is accepted at most once (atomic compare-and-set on users.mfa_last_step): replaying a code, even
 *    within its validity window, fails.
 *  - Recovery codes are 50 random bits each, single use, stored only as SHA-256. Regenerating replaces the whole set.
 *  - Second-factor attempts are throttled per account with the shared, bounded throttle.
 *  - Disabling MFA, regenerating codes and enrolling require a recent password proof; disabling additionally needs a
 *    valid second factor, and ends the user's other sessions.
 */
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { getConfig } from "../config/env.js";
import { usersRepository } from "../db/repositories/users.repository.js";
import { mfaRecoveryCodesRepository } from "../db/repositories/security.repository.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";
import { securityEvents } from "../security/security-events.js";
import { AuthChallengeError, ConflictError, ValidationError } from "../shared/errors.js";
import { loginThrottle } from "./login-throttle.js";
import { open, seal, SecretBoxUnavailableError } from "./secret-box.js";
import { generateSecret, otpauthUri, verifyCode } from "./totp.js";

const RECOVERY_CODE_COUNT = 10;
const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

type UserRow = NonNullable<Awaited<ReturnType<typeof usersRepository.findById>>>;
export interface MfaActor {
  userId: string;
  email: string;
  ip?: string;
  userAgent?: string;
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashRecovery = (code: string) => createHash("sha256").update(normalizeRecovery(code)).digest("hex");

function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += BASE32[b % 32];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

function throttleKey(userId: string) {
  return `mfa:${userId}`;
}

async function guardThrottle(userId: string, actor: MfaActor) {
  const decision = await loginThrottle.check(throttleKey(userId), actor.ip ?? "");
  if (!decision.allowed) {
    await securityEvents.record({ type: "auth.mfa.throttled", outcome: "denied", userId, ip: actor.ip, userAgent: actor.userAgent });
    throw new AuthChallengeError("Too many attempts. Wait a moment and try again.", "THROTTLED", 429, decision.retryAfterSec);
  }
}

async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await mfaRecoveryCodesRepository.replaceAll({ userId, codeHashes: codes.map(hashRecovery) });
  return codes;
}

function secretOf(user: UserRow): string {
  if (!user.mfaSecretEnc) throw new ConflictError("MFA is not set up for this account");
  return open(user.mfaSecretEnc, user.id);
}

/** A valid current TOTP code, accepted once. Returns the step, or null. Records the step atomically. */
async function acceptTotp(user: UserRow, code: string): Promise<boolean> {
  const step = verifyCode(secretOf(user), code);
  if (step === null) return false;
  return usersRepository.acceptMfaStep({ id: user.id, step });
}

export const mfaService = {
  async status(user: UserRow) {
    return {
      enabled: !!user.mfaEnabledAt,
      enrolledAt: user.mfaEnabledAt?.toISOString() ?? null,
      recoveryCodesRemaining: user.mfaEnabledAt ? await mfaRecoveryCodesRepository.countUnused({ userId: user.id }) : 0,
      enforcement: getConfig().auth.mfa.enforcement,
    };
  },

  /** Starts enrolment: returns the seed (shown once, for manual entry) and the QR code. Needs a recent password proof. */
  async beginEnrollment(user: UserRow, actor: MfaActor) {
    if (user.mfaEnabledAt) throw new ConflictError("MFA is already enabled. Disable it before enrolling a new device.");
    let sealed: string;
    const secret = generateSecret();
    try {
      sealed = seal(secret, user.id);
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) throw new ConflictError("Multi-factor authentication is not available on this server.");
      throw err;
    }
    await usersRepository.setPendingMfaSecret({ id: user.id, secretEnc: sealed });
    const uri = otpauthUri(secret, user.email);
    await securityEvents.record({ type: "auth.mfa.enrollment_started", outcome: "info", userId: user.id, ip: actor.ip, userAgent: actor.userAgent });
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  },

  /** Confirms enrolment with a code from the authenticator; returns the recovery codes (shown once). */
  async confirmEnrollment(user: UserRow, code: string, actor: MfaActor): Promise<string[]> {
    if (user.mfaEnabledAt) throw new ConflictError("MFA is already enabled");
    if (!user.mfaSecretEnc) throw new ValidationError("Start enrolment first");
    await guardThrottle(user.id, actor);
    const step = verifyCode(secretOf(user), code);
    if (step === null || !(await usersRepository.enableMfa({ id: user.id, step }))) {
      await loginThrottle.recordFailure(throttleKey(user.id), actor.ip ?? "");
      await securityEvents.record({ type: "auth.mfa.failed", outcome: "failure", userId: user.id, ip: actor.ip, userAgent: actor.userAgent, metadata: { stage: "enrollment" } });
      throw new ValidationError("That code is not valid. Check your authenticator and try again.");
    }
    const codes = await generateRecoveryCodes(user.id);
    await securityEvents.record({ type: "auth.mfa.enrolled", outcome: "success", userId: user.id, ip: actor.ip, userAgent: actor.userAgent });
    return codes;
  },

  /**
   * Second-factor step of a login. Accepts a TOTP code or a recovery code. Returns which was used.
   * Throws a ValidationError for a wrong code and AuthChallengeError(THROTTLED) when attempts are being limited.
   */
  async verifyLogin(user: UserRow, input: { code?: string; recoveryCode?: string }, actor: MfaActor): Promise<"totp" | "recovery"> {
    if (!user.mfaEnabledAt) throw new ConflictError("MFA is not enabled for this account");
    await guardThrottle(user.id, actor);
    const fail = async (reason: string): Promise<never> => {
      await loginThrottle.recordFailure(throttleKey(user.id), actor.ip ?? "");
      await securityEvents.record({ type: "auth.mfa.failed", outcome: "failure", userId: user.id, ip: actor.ip, userAgent: actor.userAgent, metadata: { reason } });
      throw new ValidationError("That code is not valid.");
    };

    if (input.recoveryCode) {
      const ok = await mfaRecoveryCodesRepository.consume({ userId: user.id, codeHash: hashRecovery(input.recoveryCode), now: new Date() });
      if (!ok) return fail("recovery_code");
      await loginThrottle.recordSuccess(throttleKey(user.id), actor.ip ?? "");
      await securityEvents.record({
        type: "auth.mfa.recovery_code_used",
        outcome: "success",
        userId: user.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { remaining: await mfaRecoveryCodesRepository.countUnused({ userId: user.id }) },
      });
      return "recovery";
    }
    if (!input.code) throw new ValidationError("Enter the code from your authenticator app.");
    const step = verifyCode(secretOf(user), input.code);
    if (step === null) return fail("totp");
    if (!(await usersRepository.acceptMfaStep({ id: user.id, step }))) {
      await securityEvents.record({ type: "auth.mfa.replay_rejected", outcome: "denied", userId: user.id, ip: actor.ip, userAgent: actor.userAgent });
      return fail("replay");
    }
    await loginThrottle.recordSuccess(throttleKey(user.id), actor.ip ?? "");
    await securityEvents.record({ type: "auth.mfa.verified", outcome: "success", userId: user.id, ip: actor.ip, userAgent: actor.userAgent });
    return "totp";
  },

  /** Replaces the recovery codes. The caller has already proven the password recently; a valid TOTP is required too. */
  async regenerateRecoveryCodes(user: UserRow, code: string, actor: MfaActor): Promise<string[]> {
    if (!user.mfaEnabledAt) throw new ConflictError("MFA is not enabled");
    await guardThrottle(user.id, actor);
    if (!(await acceptTotp(user, code))) {
      await loginThrottle.recordFailure(throttleKey(user.id), actor.ip ?? "");
      throw new ValidationError("That code is not valid.");
    }
    const codes = await generateRecoveryCodes(user.id);
    await securityEvents.record({ type: "auth.mfa.recovery_codes_regenerated", outcome: "success", userId: user.id, ip: actor.ip, userAgent: actor.userAgent });
    return codes;
  },

  /**
   * Turns MFA off. The caller has verified the password; a valid TOTP or recovery code is required as well, so a
   * stolen session alone cannot remove the factor. Ends the user's OTHER sessions.
   */
  async disable(user: UserRow, input: { code?: string; recoveryCode?: string }, actor: MfaActor, keepSessionId: string): Promise<void> {
    if (!user.mfaEnabledAt) throw new ConflictError("MFA is not enabled");
    await guardThrottle(user.id, actor);
    let ok = false;
    if (input.recoveryCode) {
      ok = await mfaRecoveryCodesRepository.consume({ userId: user.id, codeHash: hashRecovery(input.recoveryCode), now: new Date() });
    } else if (input.code) {
      ok = await acceptTotp(user, input.code);
    }
    if (!ok) {
      await loginThrottle.recordFailure(throttleKey(user.id), actor.ip ?? "");
      await securityEvents.record({ type: "auth.mfa.failed", outcome: "failure", userId: user.id, ip: actor.ip, userAgent: actor.userAgent, metadata: { stage: "disable" } });
      throw new ValidationError("That code is not valid.");
    }
    await usersRepository.clearMfa({ id: user.id });
    await mfaRecoveryCodesRepository.deleteAll({ userId: user.id });
    const revoked = await sessionsRepository.deleteOthersForUser({ userId: user.id, keepId: keepSessionId });
    await securityEvents.record({
      type: "auth.mfa.disabled",
      outcome: "success",
      userId: user.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { otherSessionsRevoked: revoked },
    });
  },
};
