import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getConfig } from "../../config/env.js";
import { runInTenant } from "../../db/tenant-context.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { enforceDemoApiRateLimit } from "../../security/rate-limits.js";
import { logger } from "../../shared/logger.js";
import { KNOWLEDGE_CATEGORIES } from "./knowledge.schemas.js";

/** A key shorter than this is treated as "not configured": the endpoint stays off rather than run with a weak secret. */
const MIN_KEY_LENGTH = 24;

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** x-api-key, Authorization: Bearer / Basic (password part), or ?token= (the one query name the log scrubber masks). */
function presentedKey(req: Pick<FastifyRequest, "headers" | "query"> & { params?: unknown }): string | null {
  const pathKey = (req.params as { key?: unknown } | undefined)?.key;
  if (typeof pathKey === "string" && pathKey) return pathKey;
  const h = req.headers;
  if (typeof h["x-api-key"] === "string") return h["x-api-key"];
  const auth = h.authorization;
  if (typeof auth === "string") {
    if (auth.startsWith("Bearer ")) return auth.slice(7);
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      return sep >= 0 ? decoded.slice(sep + 1) : decoded;
    }
  }
  const token = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof token === "string" ? token : null;
}

/**
 * Read-only demo endpoint for Exotel's built-in Voice Agent "API Integration" test (a temporary experiment with a
 * separate Exotel account; it has nothing to do with the AgentStream media path).
 *
 *   GET /api/telephony/exotel/demo/property-details[?topic=pricing|configurations|...]
 *   GET /api/telephony/exotel/demo/k/<key>/property-details[?topic=...]   (key in the path, for forms that cannot send it otherwise)
 *
 * It returns the approved knowledge of ONE project, named by EXOTEL_DEMO_PROJECT_ID: the same facts the AI is already
 * allowed to quote. No leads, calls, users or contact data, and nothing is written. It is off (a plain 404) unless
 * EXOTEL_DEMO_API_KEY (24+ chars) and EXOTEL_DEMO_PROJECT_ID are both set. The key is separate from the telephony
 * webhook secret, so the experimental account never holds the production one.
 */
export async function demoPropertyRoutes(app: FastifyInstance) {
  // The key may also be a path segment (/demo/k/<key>/property-details): Exotel's API Integration form keeps the path
  // but strips a query string and cannot hold a header value. redactUrl masks the segment in request logs.
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { apiKey, projectId } = getConfig().demoApi;
    if (apiKey.length < MIN_KEY_LENGTH || !projectId) return reply.status(404).send({ error: "Not found" });

    await enforceDemoApiRateLimit(req.ip);
    const key = presentedKey(req);
    if (!key || !sameSecret(key, apiKey)) {
      logger.warn("demo-property: unauthorized request rejected");
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const project = await projectsRepository.findActiveByIdSystem({ id: projectId });
    if (!project) return reply.status(404).send({ error: "Demo project not found" });
    const rows = await runInTenant({ organizationId: project.organizationId }, async () =>
      projectsRepository.getKnowledge({ organizationId: project.organizationId, projectId: project.id }),
    );
    const byTopic = new Map(rows.map((r) => [r.category as string, r.content]));
    const available = KNOWLEDGE_CATEGORIES.filter((c) => byTopic.has(c));

    const topic = (req.query as Record<string, unknown> | undefined)?.topic;
    const header = { name: project.name, location: project.location, description: project.description ?? undefined };
    if (topic === undefined || topic === "") return reply.send({ project: header, availableTopics: available });
    if (typeof topic !== "string" || !available.includes(topic as (typeof KNOWLEDGE_CATEGORIES)[number])) {
      return reply.status(400).send({ error: `Unknown topic. Use one of: ${available.join(", ")}`, availableTopics: available });
    }
    return reply.send({ project: header, topic, info: byTopic.get(topic) });
  };
  app.get("/api/telephony/exotel/demo/property-details", handler);
  app.get("/api/telephony/exotel/demo/k/:key/property-details", handler);
}
