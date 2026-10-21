import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getConfig } from "../../config/env.js";
import { burnPasswordCheck, verifyPassword } from "../../auth/password.js";
import { sessionService } from "../../auth/session.service.js";
import { clearSessionCookie, setSessionCookie } from "../../auth/auth.plugin.js";
import { usersRepository } from "../../db/repositories/users.repository.js";
import { membershipsRepository } from "../../db/repositories/memberships.repository.js";
import { AuthChallengeError, ForbiddenError } from "../../shared/errors.js";
import { isPublicRequest } from "../../security/telephony-auth.js";
import { securityEvents } from "../../security/security-events.js";
import { routeRateLimit } from "../../security/rate-limits.js";
import { loginThrottle } from "../../auth/login-throttle.js";
import { parseInput } from "../../shared/validation.js";
import { usersService } from "../users/users.service.js";
import { modulesService } from "../modules/modules.service.js";
import { accountRecovery } from "./account-recovery.js";
import { MAX_PASSWORD_LENGTH } from "../../auth/password-policy.js";

const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
});

// Same message for unknown email, wrong password and disabled account.
const switchBody = z.object({ organizationId: z.uuid() });

const acceptInviteBody = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(10).max(128),
});

const forgotPasswordBody = z.object({ email: z.email().max(320) });

const resetPasswordBody = z.object({
  token: z.string().min(1).max(200),
  // Bounded generously and judged by checkPassword, so a too-short password gets the policy's message rather than
  // a schema error - the same arrangement /change-password uses.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH + 128),
});

const accountTokenBody = z.object({ token: z.string().min(1).max(200) });

const GENERIC_LOGIN_ERROR = "Invalid email or password";

export async function authRoutes(app: FastifyInstance) {
  /** Lets the login page know whether to show the dev-only demo button. */
  app.get("/api/auth/config", async (req, reply) => {
    return reply.send({ data: { demoLoginEnabled: getConfig().auth.demoLoginEnabled && !isPublicRequest(req) } });
  });

  app.post(
    "/api/auth/login",
    // Brute-force protection: 10 attempts per 15 minutes per IP + email.
    {
      preHandler: routeRateLimit({
        name: "login",
        max: 10,
        windowMs: 15 * 60_000,
        key: (req) => `${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").slice(0, 320).toLowerCase()}`,
      }),
    },
    async (req, reply) => {
    const { email, password } = parseInput(loginBody, req.body);
    const ip = req.ip;
    const userAgent = req.headers["user-agent"];

    // Shared, bounded throttle (per account+IP, per IP, per account). A throttled attempt is refused before the
    // password is checked and does not extend the lock.
    const decision = await loginThrottle.check(email, ip);
    if (!decision.allowed) {
      await securityEvents.record({ type: "auth.login.throttled", outcome: "denied", ip, userAgent, metadata: { scope: decision.scope } });
      throw new AuthChallengeError("Too many sign-in attempts. Please wait and try again.", "THROTTLED", 429, decision.retryAfterSec);
    }

    const user = await usersRepository.findByEmail({ email });
    if (!user || !user.isActive) {
      await burnPasswordCheck(password);
      await loginThrottle.recordFailure(email, ip);
      await securityEvents.record({
        type: "auth.login.failed",
        outcome: "failure",
        userId: user?.id ?? null,
        ip,
        userAgent,
        metadata: { reason: user ? "disabled" : "unknown_email" },
      });
      return reply.status(401).send({ error: GENERIC_LOGIN_ERROR });
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await loginThrottle.recordFailure(email, ip);
      await securityEvents.record({ type: "auth.login.failed", outcome: "failure", userId: user.id, ip, userAgent, metadata: { reason: "bad_password" } });
      return reply.status(401).send({ error: GENERIC_LOGIN_ERROR });
    }
    await loginThrottle.recordSuccess(email, ip);
    await usersRepository.touchLogin({ id: user.id });
    const orgs = await membershipsRepository.listForUser({ userId: user.id });
    const mfaPending = !!user.mfaEnabledAt;
    const { token, expiresAt } = await sessionService.create({
      userId: user.id,
      activeOrganizationId: orgs[0]?.organizationId ?? null,
      ipAddress: ip,
      userAgent,
      mfaPending,
    });
    await securityEvents.record({
      type: mfaPending ? "auth.login.mfa_required" : "auth.login.success",
      outcome: mfaPending ? "info" : "success",
      userId: user.id,
      organizationId: orgs[0]?.organizationId ?? null,
      ip,
      userAgent,
    });
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ data: { id: user.id, email: user.email, name: user.name, mfaRequired: mfaPending } });
    },
  );

  /**
   * Dev-only: sign in as the seeded demo user without a password so the demo
   * page works out of the box. Disabled when DEMO_LOGIN_ENABLED=false (the
   * default in production) and never served to tunnelled/public requests.
   */
  app.post("/api/auth/demo-login", async (req, reply) => {
    const cfg = getConfig().auth;
    if (!cfg.demoLoginEnabled || isPublicRequest(req)) {
      return reply.status(404).send({ error: "Not found" });
    }
    const user = await usersRepository.findByEmail({ email: cfg.demoUserEmail });
    if (!user || !user.isActive) {
      return reply.status(404).send({ error: "Demo user not found. Run: pnpm db:seed" });
    }
    await usersRepository.touchLogin({ id: user.id });
    const orgs = await membershipsRepository.listForUser({ userId: user.id });
    const { token, expiresAt } = await sessionService.create({
      userId: user.id,
      activeOrganizationId: orgs[0]?.organizationId ?? null,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      mfaPending: !!user.mfaEnabledAt,
    });
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ data: { id: user.id, email: user.email, name: user.name, mfaRequired: !!user.mfaEnabledAt } });
  });

  /**
   * PUBLIC: join an organization with an invite token. Rate limited per IP
   * (the token is the credential, so keying on it would let an attacker rotate guesses).
   */
  app.post(
    "/api/auth/accept-invite",
    { preHandler: routeRateLimit({ name: "accept-invite", max: 10, windowMs: 15 * 60_000, key: (req) => req.ip }) },
    async (req, reply) => {
      const body = parseInput(acceptInviteBody, req.body);
      const { user, organizationId } = await usersService.acceptInvite(body);
      await usersRepository.touchLogin({ id: user.id });
      const mfaPending = !!user.mfaEnabledAt;
      const { token, expiresAt } = await sessionService.create({
        userId: user.id,
        activeOrganizationId: organizationId,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        mfaPending,
      });
      await securityEvents.record({ type: mfaPending ? "auth.login.mfa_required" : "auth.login.success", outcome: mfaPending ? "info" : "success", userId: user.id, organizationId, ip: req.ip, userAgent: req.headers["user-agent"], metadata: { via: "invitation" } });
      setSessionCookie(reply, token, expiresAt);
      return reply.send({ data: { id: user.id, email: user.email, name: user.name, mfaRequired: mfaPending } });
    },
  );

  /**
   * PUBLIC: start a password reset. ALWAYS 200 { ok: true } - for a real address, a non-existent one, a
   * deactivated account and a failed send alike. This endpoint is the product's only account-enumeration risk, so
   * every channel is closed deliberately: the status and body never vary (there is no branch that can answer
   * otherwise), the provider send is dispatched but not awaited, and the unknown-address path performs equivalent
   * work instead of returning early, so the latency class matches (see account-recovery.ts).
   *
   * Throttled on TWO keys, because the abuse shapes differ:
   *   per IP     bounds a sweep over many addresses from one source (an enumeration attempt);
   *   per address bounds mail-bombing one victim's inbox from many sources.
   * Neither is an existence oracle: both count only what the caller itself submitted. Both fail CLOSED
   * (routeRateLimit), so a counter-store outage cannot turn the limits off.
   */
  app.post(
    "/api/auth/forgot-password",
    {
      preHandler: [
        routeRateLimit({ name: "forgot-password-ip", max: 10, windowMs: 15 * 60_000, key: (req) => req.ip }),
        routeRateLimit({
          name: "forgot-password-address",
          max: 3,
          windowMs: 15 * 60_000,
          key: (req) => String((req.body as { email?: unknown } | undefined)?.email ?? "").slice(0, 320).trim().toLowerCase(),
        }),
      ],
    },
    async (req, reply) => {
      const { email } = parseInput(forgotPasswordBody, req.body);
      await accountRecovery.requestPasswordReset({ email }, { ip: req.ip, userAgent: req.headers["user-agent"] });
      // One fixed answer. Nothing above can change it.
      return reply.send({ data: { ok: true } });
    },
  );

  /**
   * PUBLIC: finish a password reset. Rate limited per IP, NOT per token - keying on the credential would let an
   * attacker rotate guesses past the limit (the same reasoning as /accept-invite).
   *
   * A completed reset revokes every session, then issues a fresh one. If the account has MFA, that session is
   * created mfaPending exactly as a login's would be: a reset proves control of the MAILBOX, and MFA exists to
   * survive a compromised password or mailbox. Letting a reset mint a verified session would turn inbox access
   * into a complete second-factor bypass. The caller gets mfaRequired: true and can only reach /mfa/verify,
   * /logout and /me until they produce a TOTP code or a recovery code; losing both remains an operator action
   * (auth.mfa.reset_by_operator), which is the deliberate, auditable path.
   */
  app.post(
    "/api/auth/reset-password",
    { preHandler: routeRateLimit({ name: "reset-password", max: 10, windowMs: 15 * 60_000, key: (req) => req.ip }) },
    async (req, reply) => {
      const body = parseInput(resetPasswordBody, req.body);
      const { user, sessionsRevoked, mfaRequired } = await accountRecovery.completePasswordReset(body, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      const orgs = await membershipsRepository.listForUser({ userId: user.id });
      const { token, expiresAt } = await sessionService.create({
        userId: user.id,
        activeOrganizationId: orgs[0]?.organizationId ?? null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        mfaPending: mfaRequired,
      });
      await securityEvents.record({
        type: mfaRequired ? "auth.login.mfa_required" : "auth.login.success",
        outcome: mfaRequired ? "info" : "success",
        userId: user.id,
        organizationId: orgs[0]?.organizationId ?? null,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        metadata: { via: "password_reset" },
      });
      setSessionCookie(reply, token, expiresAt);
      return reply.send({
        data: { id: user.id, email: user.email, name: user.name, mfaRequired, sessionsRevoked },
      });
    },
  );

  /**
   * PUBLIC: confirm an e-mail address (the token is the credential). Per-IP limit, same reasoning as above.
   * Single-use: a replayed link gets the same message as an unknown one.
   */
  app.post(
    "/api/auth/email-verification/confirm",
    { preHandler: routeRateLimit({ name: "email-verification-confirm", max: 10, windowMs: 15 * 60_000, key: (req) => req.ip }) },
    async (req, reply) => {
      const body = parseInput(accountTokenBody, req.body);
      const result = await accountRecovery.confirmEmailVerification(body, { ip: req.ip, userAgent: req.headers["user-agent"] });
      return reply.send({ data: { ok: true, ...result } });
    },
  );

  app.post("/api/auth/logout",async (req, reply) => {
    const token = req.cookies?.[getConfig().auth.cookieName];
    if (token) await sessionService.revoke(token);
    if (req.auth) await securityEvents.record({ type: "auth.logout", outcome: "success", userId: req.auth.userId, ip: req.ip });
    clearSessionCookie(reply);
    return reply.send({ data: { ok: true } });
  });

  /** Who am I, which organization am I working in, and which others can I switch to. */
  app.get("/api/auth/me", async (req, reply) => {
    // The global gate guarantees req.auth here.
    const a = req.auth!;
    const active = a.organizations.find((o) => o.id === a.organizationId) ?? null;
    // Enabled optional modules of the ACTIVE organization (the Voice AI core is always on).
    const organization = active ? { ...active, modules: await modulesService.enabledKeys({ organizationId: active.id }) } : null;
    return reply.send({
      data: {
        id: a.userId,
        email: a.email,
        name: a.name,
        organization,
        organizations: a.organizations,
        security: {
          mfaEnabled: a.mfaEnabled,
          mfaPending: a.mfaPending,
          mfaEnrollmentRequired: a.mfaEnrollmentRequired,
          mfaEnforcement: getConfig().auth.mfa.enforcement,
        },
      },
    });
  });

  /** Switch the organization this session works in (users can belong to several). */
  app.post("/api/auth/switch-organization", async (req, reply) => {
    const { organizationId } = parseInput(switchBody, req.body);
    const a = req.auth!;
    if (!a.organizations.some((o) => o.id === organizationId)) {
      throw new ForbiddenError("You are not a member of that organization");
    }
    await sessionService.setActiveOrganization(a.sessionId, organizationId);
    return reply.send({ data: { organizationId } });
  });
}
