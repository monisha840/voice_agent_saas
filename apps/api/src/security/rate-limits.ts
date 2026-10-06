/**
 * Rate limiting policy.
 *
 * LIMITATION: all counters live in this process's memory (no Redis). They
 * reset on restart and are not shared between API instances, so with N
 * instances the effective limit is up to N times higher. Fine for a single
 * node; move to a shared store before scaling out.
 *
 * Exotel endpoints and /health are never throttled: Exotel retries and
 * streams from a handful of IPs, and throttling them would drop real calls.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitPluginOptions } from "@fastify/rate-limit";
import { getConfig } from "../config/env.js";
import type { RequestContext } from "../auth/context.js";

export class RateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

const EXEMPT_PATHS = [/^\/health$/, /^\/api\/telephony\/exotel\//];

export function isRateLimitExempt(url: string): boolean {
  const path = url.split("?")[0];
  return EXEMPT_PATHS.some((re) => re.test(path));
}

/** Sliding-window counter keyed by string. Memory-only (see the limitation above). */
class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  /** Returns null if allowed (and counts the hit), else the seconds until the oldest hit expires. */
  hit(key: string, max: number, windowMs: number, now: number): number | null {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= windowMs)) this.hits.delete(k);
    }
    return null;
  }

  clear() {
    this.hits.clear();
  }
}

const ipHits = new SlidingWindow();
const callHits = new SlidingWindow();

/**
 * Global per-IP default for the whole API (generous). Registered as an
 * instance-level onRequest hook BEFORE the login gate so unauthenticated and
 * unknown-route floods are counted too. Exempt paths are skipped entirely.
 * Route-specific limits (login: 10 per 15 min per IP+email, via the
 * @fastify/rate-limit plugin's config.rateLimit) apply in addition.
 */
export async function globalRateLimitHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isRateLimitExempt(req.url) || req.method === "OPTIONS") return;
  const { apiMax, apiWindowMs } = getConfig().rateLimit;
  const retry = ipHits.hit(req.ip, apiMax, apiWindowMs, Date.now());
  if (retry !== null) {
    reply.header("retry-after", String(retry));
    throw new RateLimitError(`Too many requests. Try again in ${retry} seconds.`, retry);
  }
}

/** Plugin options for the route-level limits (login); global limiting is globalRateLimitHook. */
export function routeRateLimitPluginOptions(): RateLimitPluginOptions {
  return {
    global: false,
    // Thrown, then rendered by the app error handler as the uniform { error } shape.
    errorResponseBuilder: (_req, ctx) => {
      const seconds = Math.max(1, Math.ceil(ctx.ttl / 1000));
      return new RateLimitError(`Too many requests. Try again in ${seconds} seconds.`, seconds);
    },
  };
}

/* ---- per-organization call-initiation limit ---- */

/** Sliding window. Throws RateLimitError (429) when the organization is over its limit. */
export function enforceCallRateLimit(ctx: RequestContext, now = Date.now()): void {
  const { callsPerOrgMax: max, callsPerOrgWindowMs: windowMs } = getConfig().rateLimit;
  const retry = callHits.hit(ctx.organizationId, max, windowMs, now);
  if (retry !== null) {
    throw new RateLimitError(
      `Call limit reached: at most ${max} calls per ${Math.round(windowMs / 1000)} seconds per organization. Try again in ${retry} seconds.`,
      retry,
    );
  }
}

/**
 * Fastify preHandler (runs after the login gate, so req.ctx is set):
 *   app.post("/api/leads/:id/call", { preHandler: callRateLimitPreHandler }, handler)
 */
export async function callRateLimitPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.ctx) return; // unauthenticated requests never get here (login gate); nothing to key on
  try {
    enforceCallRateLimit(req.ctx);
  } catch (err) {
    if (err instanceof RateLimitError) reply.header("retry-after", String(err.retryAfterSeconds));
    throw err;
  }
}

/** Test helper. */
export function resetCallRateLimits(): void {
  ipHits.clear();
  callHits.clear();
}
