/**
 * GET /metrics (Prometheus text format). NOT public:
 *  - 404 unless METRICS_TOKEN is set (a token shorter than 16 characters counts as unset);
 *  - 404 for any request that arrived through a proxy/tunnel or with a non-private Host (same test as the public
 *    access guard), so it is never reachable from the internet even with the token;
 *  - 401 unless `Authorization: Bearer <METRICS_TOKEN>` matches (constant-time compare).
 * It is excluded from the session login gate (a scraper has no cookie); the bearer token is its credential.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../config/env.js";
import { isPublicRequest } from "../security/telephony-auth.js";
import { metrics } from "./metrics.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    const token = getConfig().metricsToken;
    if (!token || isPublicRequest(req)) return reply.status(404).send({ error: "Not found" });
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(digest(presented), digest(token))) {
      return reply.status(401).header("www-authenticate", "Bearer").send({ error: "Unauthorized" });
    }
    return reply
      .status(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(metrics.render());
  });
}
