/**
 * Authentication wiring for the Fastify app:
 *  - CORS limited to the dashboard origin(s), with credentials (cookies)
 *  - cookie parsing
 *  - a CSRF Origin check on state-changing requests
 *  - session resolution into `req.auth` for every request
 *  - a global gate: every route requires a login except the explicit public list
 *
 * The Exotel endpoints are NOT behind the login gate; they are protected by
 * the shared webhook secret instead (security/telephony-auth.ts).
 */
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getConfig } from "../config/env.js";
import { sessionService } from "./session.service.js";
import { membershipsRepository } from "../db/repositories/memberships.repository.js";
import { organizationModulesRepository } from "../db/repositories/organization-modules.repository.js";
import { userContext, type RequestContext } from "./context.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import type { AuthContext } from "./auth.types.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set when the request carries a valid session cookie. */
    auth: AuthContext | null;
    /** Set when logged in AND a member of the active organization. Use requireContext(req). */
    ctx: RequestContext | null;
  }
}

/** Reachable without logging in. */
const PUBLIC_PATHS = [
  /^\/health$/,
  /^\/ready$/,
  /^\/api\/telephony\/exotel\//, // webhook-secret protected instead
  /^\/api\/auth\/(login|demo-login|config|accept-invite)$/,
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function registerAuth(app: FastifyInstance) {
  const cfg = getConfig().auth;

  await app.register(cors, { origin: cfg.allowedOrigins, credentials: true });
  await app.register(cookie);
  app.decorateRequest("auth", null);
  app.decorateRequest("ctx", null);

  // CSRF: browsers always send Origin on cross-origin POST/PUT/PATCH/DELETE.
  // A cookie-authenticated unsafe request from a foreign origin is refused.
  // Requests with no Origin header are non-browser clients, which cannot be
  // tricked into sending the cookie cross-site.
  app.addHook("onRequest", async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin) && req.cookies?.[cfg.cookieName]) {
      return reply.status(403).send({ error: "Cross-origin request blocked" });
    }
  });

  app.addHook("onRequest", async (req) => {
    const token = req.cookies?.[cfg.cookieName];
    if (!token) return;
    const resolved = await sessionService.resolve(token);
    if (!resolved) return;

    // Memberships are read on every request (never cached in the session), so
    // a role change or removal takes effect immediately.
    const orgs = await membershipsRepository.listForUser({ userId: resolved.user.id });
    let active = orgs.find((o) => o.organizationId === resolved.session.activeOrganizationId) ?? null;
    if (!active && orgs.length > 0) {
      active = orgs[0];
      await sessionService.setActiveOrganization(resolved.session.id, active.organizationId);
    }
    req.auth = {
      sessionId: resolved.session.id,
      userId: resolved.user.id,
      email: resolved.user.email,
      name: resolved.user.name,
      organizationId: active?.organizationId ?? null,
      role: active?.role ?? null,
      organizations: orgs.map((o) => ({ id: o.organizationId, name: o.organizationName, slug: o.organizationSlug, role: o.role })),
    };
    if (active) {
      // Which optional modules this organization has on: module permissions are only usable while their module is enabled.
      const enabledModules = await organizationModulesRepository.listEnabledKeys({ organizationId: active.organizationId });
      req.ctx = userContext(active.organizationId, resolved.user.id, active.role, enabledModules);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0];
    if (PUBLIC_PATHS.some((re) => re.test(path))) return;
    if (!req.auth) return reply.status(401).send({ error: "Authentication required" });
    // Everything except the auth endpoints needs an organization to work in.
    if (!req.ctx && !path.startsWith("/api/auth/")) {
      return reply
        .status(403)
        .send({ error: "Your account is not a member of any organization", code: "NO_ORGANIZATION" });
    }
  });
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  const cfg = getConfig().auth;
  reply.setCookie(cfg.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.cookieSecure,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  const cfg = getConfig().auth;
  reply.clearCookie(cfg.cookieName, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.cookieSecure });
}

/** The tenant-scoped context for this request. Routes must call this and pass it to services. */
export function requireContext(req: { auth: AuthContext | null; ctx: RequestContext | null }): RequestContext {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.ctx) throw new ForbiddenError("Your account is not a member of any organization");
  return req.ctx;
}
