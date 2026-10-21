/**
 * Response-level hardening for the JSON API: security headers, uniform 404/405
 * bodies. (Body limit and trustProxy are Fastify constructor options in app.ts.)
 */
import type { FastifyInstance } from "fastify";
import { getConfig } from "../config/env.js";

export function registerSecurityHeaders(app: FastifyInstance): void {
  const hsts = getConfig().auth.cookieSecure || getConfig().nodeEnv === "production";
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    if (hsts) reply.header("strict-transport-security", "max-age=15552000; includeSubDomains");
    return payload;
  });
}

/** Unknown route -> { error: "Not found" }; known path with another method -> 405 + Allow. */
export function registerUniformNotFound(app: FastifyInstance): void {
  const routes: Array<{ method: string; re: RegExp }> = [];
  app.addHook("onRoute", (route) => {
    if (route.url.includes("*")) return; // wildcard (e.g. CORS preflight) would match everything
    const pattern = route.url.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z0-9_]+/g, "[^/]+");
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, re: new RegExp(`^${pattern}/?$`) });
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    const allowed = [...new Set(routes.filter((r) => r.re.test(path)).map((r) => r.method))];
    if (allowed.length > 0) {
      return reply.status(405).header("allow", allowed.join(", ")).send({ error: "Method not allowed" });
    }
    return reply.status(404).send({ error: "Not found" });
  });
}
