/**
 * Authentication for the endpoints Exotel calls (status callback and the
 * media-stream WebSocket), and a guard that keeps everything else off the
 * public internet.
 *
 * Telephony auth: a shared secret (EXOTEL_AGENTSTREAM_WEBHOOK_SECRET),
 * accepted as `?token=` on the URL we hand to Exotel, or as the password of
 * an `Authorization: Basic` header (Exotel's documented WebSocket auth).
 * With no secret configured, endpoints are open ONLY when
 * TELEPHONY_PROVIDER=mock (local development).
 *
 * Public-access guard: when a request arrives through a tunnel/proxy
 * (X-Forwarded-* present) or with a non-local Host header, only /health, /ready and
 * /api/telephony/exotel/* are served; the dashboard/lead/call/project APIs
 * return 404. Direct local access (127.0.0.1 / localhost) is unaffected.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getConfig } from "../config/env.js";
import { maskQueryCredentials } from "../shared/logger.js";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isTelephonyAuthorized(req: Pick<FastifyRequest, "headers" | "query">): boolean {
  const cfg = getConfig();
  const secret = cfg.exotel.agentStreamWebhookSecret;
  if (!secret) return cfg.telephonyProvider === "mock";

  const token = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof token === "string" && safeEqual(token, secret)) return true;

  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const password = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    if (safeEqual(password, secret)) return true;
  }
  return false;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PUBLIC_PATHS = [/^\/health$/, /^\/ready$/, /^\/api\/telephony\/exotel\//];

function hostWithoutPort(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase();
  return hostHeader.split(":")[0].toLowerCase();
}

export function isPublicRequest(req: Pick<FastifyRequest, "headers">): boolean {
  const h = req.headers;
  if (h["x-forwarded-for"] || h["x-forwarded-host"] || h.forwarded) return true;
  const host = hostWithoutPort(h.host);
  return !(LOCAL_HOSTS.has(host) || getConfig().privateHosts.includes(host));
}

export function registerPublicAccessGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isPublicRequest(req)) return;
    const path = req.url.split("?")[0];
    if (PUBLIC_PATHS.some((re) => re.test(path))) return;
    return reply.status(404).send({ error: "Not found" });
  });
}

/** Removes the shared secret from a URL before it is logged. */
export function redactUrl(url: string): string {
  return maskQueryCredentials(url).replace(/(\/demo\/k\/)[^/?#]+/g, "$1[redacted]");
}
