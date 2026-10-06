import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getConfig } from "../../config/env.js";
import { burnPasswordCheck, verifyPassword } from "../../auth/password.js";
import { sessionService } from "../../auth/session.service.js";
import { clearSessionCookie, setSessionCookie } from "../../auth/auth.plugin.js";
import { usersRepository } from "../../db/repositories/users.repository.js";
import { membershipsRepository } from "../../db/repositories/memberships.repository.js";
import { ForbiddenError } from "../../shared/errors.js";
import { isPublicRequest } from "../../security/telephony-auth.js";
import { logger } from "../../shared/logger.js";
import { parseInput } from "../../shared/validation.js";
import { usersService } from "../users/users.service.js";
import { modulesService } from "../modules/modules.service.js";

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
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
          keyGenerator: (req: { ip: string; body?: unknown }) =>
            `${req.ip}:${String((req.body as { email?: string } | undefined)?.email ?? "").toLowerCase()}`,
        },
      },
    },
    async (req, reply) => {
    const { email, password } = parseInput(loginBody, req.body);
    const user = await usersRepository.findByEmail({ email });
    if (!user || !user.isActive) {
      await burnPasswordCheck(password);
      logger.warn("auth: failed login", { reason: user ? "disabled" : "unknown_email" });
      return reply.status(401).send({ error: GENERIC_LOGIN_ERROR });
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      logger.warn("auth: failed login", { reason: "bad_password", userId: user.id });
      return reply.status(401).send({ error: GENERIC_LOGIN_ERROR });
    }
    await usersRepository.touchLogin({ id: user.id });
    const orgs = await membershipsRepository.listForUser({ userId: user.id });
    const { token, expiresAt } = await sessionService.create({
      userId: user.id,
      activeOrganizationId: orgs[0]?.organizationId ?? null,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ data: { id: user.id, email: user.email, name: user.name } });
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
    });
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ data: { id: user.id, email: user.email, name: user.name } });
  });

  /**
   * PUBLIC: join an organization with an invite token. Rate limited per IP
   * (the token is the credential, so keying on it would let an attacker rotate guesses).
   */
  app.post(
    "/api/auth/accept-invite",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: (req: { ip: string }) => req.ip } } },
    async (req, reply) => {
      const body = parseInput(acceptInviteBody, req.body);
      const { user, organizationId } = await usersService.acceptInvite(body);
      await usersRepository.touchLogin({ id: user.id });
      const { token, expiresAt } = await sessionService.create({
        userId: user.id,
        activeOrganizationId: organizationId,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(reply, token, expiresAt);
      return reply.send({ data: { id: user.id, email: user.email, name: user.name } });
    },
  );

  app.post("/api/auth/logout",async (req, reply) => {
    const token = req.cookies?.[getConfig().auth.cookieName];
    if (token) await sessionService.revoke(token);
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
      data: { id: a.userId, email: a.email, name: a.name, organization, organizations: a.organizations },
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
