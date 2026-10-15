/**
 * Account security endpoints for the signed-in user: session management, re-authentication, password change and
 * TOTP multi-factor authentication. Every endpoint acts only on the caller's OWN account and sessions - there is no
 * user id in any path or body - and the sensitive ones need a recent password proof (requireRecentAuth).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPassword, hashPassword, burnPasswordCheck } from "../../auth/password.js";
import { checkPassword, MAX_PASSWORD_LENGTH, PASSWORD_PROBLEM_MESSAGE } from "../../auth/password-policy.js";
import { requireRecentAuth, setSessionCookie } from "../../auth/auth.plugin.js";
import { sessionService } from "../../auth/session.service.js";
import { mfaService } from "../../auth/mfa.service.js";
import { loginThrottle } from "../../auth/login-throttle.js";
import { usersRepository } from "../../db/repositories/users.repository.js";
import { securityEvents } from "../../security/security-events.js";
import { securityEventsRepository } from "../../db/repositories/security.repository.js";
import { AuthChallengeError, NotFoundError, UnauthorizedError, ValidationError } from "../../shared/errors.js";
import { parseInput } from "../../shared/validation.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { assertCan } from "../../auth/access.js";
import { routeRateLimit } from "../../security/rate-limits.js";

const passwordBody = z.object({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH + 128) });
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH + 128),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH + 128),
});
const codeBody = z.object({ code: z.string().min(6).max(12) });
const verifyBody = z
  .object({ code: z.string().min(6).max(12).optional(), recoveryCode: z.string().min(8).max(24).optional() })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: "Provide either code or recoveryCode" });
const disableBody = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH + 128),
    code: z.string().min(6).max(12).optional(),
    recoveryCode: z.string().min(8).max(24).optional(),
  })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: "Provide either code or recoveryCode" });
const regenBody = z.object({ code: z.string().min(6).max(12) });

/** Per-user (not per-IP) limit on sensitive operations, so shared office NATs do not interfere. */
/** Each route gets its own 15-per-15-minutes budget per user. Fails closed on a store error. */
const sensitive = (name: string) =>
  ({ preHandler: routeRateLimit({ name, max: 15, windowMs: 15 * 60_000, key: (req) => `acct:${req.auth?.userId ?? req.ip}` }) });

function actorOf(req: FastifyRequest) {
  const a = req.auth!;
  return { userId: a.userId, email: a.email, ip: req.ip, userAgent: req.headers["user-agent"] };
}

async function currentUser(req: FastifyRequest) {
  const user = await usersRepository.findById({ id: req.auth!.userId });
  if (!user || !user.isActive) throw new UnauthorizedError();
  return user;
}

/** Checks the password for a re-authentication step with the same bounded throttle as a login. */
async function proveOwnPassword(req: FastifyRequest, password: string, purpose: string) {
  const user = await currentUser(req);
  const decision = await loginThrottle.check(user.email, req.ip);
  if (!decision.allowed) {
    await securityEvents.record({ type: "auth.login.throttled", outcome: "denied", userId: user.id, ip: req.ip, metadata: { purpose } });
    throw new AuthChallengeError("Too many attempts. Please wait and try again.", "THROTTLED", 429, decision.retryAfterSec);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await burnPasswordCheck(password);
    await loginThrottle.recordFailure(user.email, req.ip);
    await securityEvents.record({ type: "auth.reauthentication.failed", outcome: "failure", userId: user.id, ip: req.ip, metadata: { purpose } });
    throw new ValidationError("Incorrect password.");
  }
  await loginThrottle.recordSuccess(user.email, req.ip);
  return user;
}

export async function accountSecurityRoutes(app: FastifyInstance) {
  // ---- sessions -----------------------------------------------------------------------------------------------
  app.get("/api/auth/sessions", async (req, reply) => {
    const sessions = await sessionService.listForUser(req.auth!.userId, req.auth!.sessionId);
    return reply.send({ data: sessions });
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", sensitive("/api/auth/sessions/:id"), async (req, reply) => {
    const id = parseInput(z.object({ id: z.uuid() }), req.params).id;
    const a = req.auth!;
    // Revoking the current session is a logout; anything else must be one of the caller's own sessions.
    const ok = await sessionService.revokeOne(a.userId, id);
    if (!ok) throw new NotFoundError("Session not found");
    await securityEvents.record({
      type: "session.revoked",
      outcome: "success",
      userId: a.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { sessionId: id, current: id === a.sessionId },
    });
    return reply.send({ data: { revoked: id, current: id === a.sessionId } });
  });

  app.post("/api/auth/sessions/revoke-others", sensitive("/api/auth/sessions/revoke-others"), async (req, reply) => {
    const a = req.auth!;
    const count = await sessionService.revokeOthers(a.userId, a.sessionId);
    await securityEvents.record({
      type: "session.revoked_others",
      outcome: "success",
      userId: a.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { count },
    });
    return reply.send({ data: { revoked: count } });
  });

  // ---- re-authentication and password -------------------------------------------------------------------------
  app.post("/api/auth/reauthenticate", sensitive("/api/auth/reauthenticate"), async (req, reply) => {
    const { password } = parseInput(passwordBody, req.body);
    const user = await proveOwnPassword(req, password, "reauthenticate");
    await sessionService.markReauthenticated(req.auth!.sessionId);
    await securityEvents.record({ type: "auth.reauthenticated", outcome: "success", userId: user.id, ip: req.ip, userAgent: req.headers["user-agent"] });
    return reply.send({ data: { ok: true } });
  });

  app.post("/api/auth/change-password", sensitive("/api/auth/change-password"), async (req, reply) => {
    const body = parseInput(changePasswordBody, req.body);
    const user = await proveOwnPassword(req, body.currentPassword, "change_password");
    if (body.newPassword === body.currentPassword) throw new ValidationError("Choose a password you have not used just now.");
    const problem = await checkPassword({ password: body.newPassword, email: user.email, name: user.name });
    if (problem) {
      await securityEvents.record({ type: "auth.password.rejected", outcome: "denied", userId: user.id, ip: req.ip, metadata: { problem } });
      throw new ValidationError(PASSWORD_PROBLEM_MESSAGE[problem]);
    }
    // New hash + end of ALL existing sessions in one transaction; this device signs in again on a fresh session
    // (session rotation), so a stolen cookie from before the change is useless.
    const revoked = await usersRepository.changePasswordRevokingSessions({
      id: user.id,
      passwordHash: await hashPassword(body.newPassword),
      keepSessionId: null,
    });
    const orgId = req.auth!.organizationId;
    const { token, expiresAt } = await sessionService.create({
      userId: user.id,
      activeOrganizationId: orgId,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      mfaPending: false, // this request already passed MFA (the gate would have refused it otherwise)
    });
    setSessionCookie(reply, token, expiresAt);
    await securityEvents.record({
      type: "auth.password.changed",
      outcome: "success",
      userId: user.id,
      organizationId: orgId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      metadata: { sessionsRevoked: revoked },
    });
    return reply.send({ data: { ok: true, otherSessionsRevoked: Math.max(0, revoked - 1) } });
  });

  // ---- MFA ----------------------------------------------------------------------------------------------------
  app.get("/api/auth/mfa", async (req, reply) => {
    return reply.send({ data: await mfaService.status(await currentUser(req)) });
  });

  /** Step 1: needs a recent password proof. Returns the seed and QR code ONCE. */
  app.post("/api/auth/mfa/enroll", sensitive("/api/auth/mfa/enroll"), async (req, reply) => {
    requireRecentAuth(req.auth!);
    const result = await mfaService.beginEnrollment(await currentUser(req), actorOf(req));
    reply.header("cache-control", "no-store");
    return reply.send({ data: result });
  });

  /** Step 2: a code from the authenticator confirms it. Returns the recovery codes ONCE. */
  app.post("/api/auth/mfa/enroll/confirm", sensitive("/api/auth/mfa/enroll/confirm"), async (req, reply) => {
    requireRecentAuth(req.auth!);
    const { code } = parseInput(codeBody, req.body);
    const user = await currentUser(req);
    const recoveryCodes = await mfaService.confirmEnrollment(user, code, actorOf(req));
    // Enrolment ends the user's other sessions (the account's security posture changed) and this one is now verified.
    await sessionService.completeMfa(req.auth!.sessionId);
    await sessionService.revokeOthers(user.id, req.auth!.sessionId);
    reply.header("cache-control", "no-store");
    return reply.send({ data: { recoveryCodes } });
  });

  /** Second-factor step of a login: the only thing a pending session may do besides logging out. */
  app.post(
    "/api/auth/mfa/verify",
    { preHandler: routeRateLimit({ name: "mfa-verify", max: 20, windowMs: 15 * 60_000, key: (req) => `mfa:${req.auth?.userId ?? req.ip}` }) },
    async (req, reply) => {
      const body = parseInput(verifyBody, req.body);
      const user = await currentUser(req);
      if (!req.auth!.mfaPending) return reply.send({ data: { ok: true, alreadyVerified: true } });
      const method = await mfaService.verifyLogin(user, body, actorOf(req));
      await sessionService.completeMfa(req.auth!.sessionId);
      await securityEvents.record({
        type: "auth.login.success",
        outcome: "success",
        userId: user.id,
        organizationId: req.auth!.organizationId,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: { mfa: method },
      });
      return reply.send({ data: { ok: true, method } });
    },
  );

  app.post("/api/auth/mfa/recovery-codes", sensitive("/api/auth/mfa/recovery-codes"), async (req, reply) => {
    requireRecentAuth(req.auth!);
    const { code } = parseInput(regenBody, req.body);
    const codes = await mfaService.regenerateRecoveryCodes(await currentUser(req), code, actorOf(req));
    reply.header("cache-control", "no-store");
    return reply.send({ data: { recoveryCodes: codes } });
  });

  app.post("/api/auth/mfa/disable", sensitive("/api/auth/mfa/disable"), async (req, reply) => {
    const body = parseInput(disableBody, req.body);
    // Password is checked HERE (not just "recently"): removing a factor needs a fresh proof plus a valid second factor.
    const user = await proveOwnPassword(req, body.password, "disable_mfa");
    await mfaService.disable(user, body, actorOf(req), req.auth!.sessionId);
    return reply.send({ data: { ok: true } });
  });

  // ---- security events (organization owners and admins) -------------------------------------------------------
  app.get("/api/security/events", async (req, reply) => {
    const ctx = requireContext(req);
    assertCan(ctx, "audit:read");
    const q = parseInput(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional(), type: z.string().max(80).optional() }),
      req.query,
    );
    const rows = await securityEventsRepository.listForOrganization({
      organizationId: ctx.organizationId,
      limit: q.limit,
      before: q.before,
      eventType: q.type,
    });
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        type: r.eventType,
        outcome: r.outcome,
        actorUserId: r.actorUserId,
        ip: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
        metadata: r.metadata,
      })),
    });
  });
}

