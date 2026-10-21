/**
 * Rate limiting policy.
 *
 * Every counter lives in PostgreSQL (table rate_limit_buckets, one atomic upsert per check), so N API instances share
 * one budget and a restart does not reset anything. There is NO per-key in-process state: the only memory held here
 * is a failure counter and one log timestamp. Keys are SHA-256 hashes (no plaintext IP, email or user id stored).
 *
 * Windows are fixed (they start at the first hit and reset when they expire), so a client can burst up to 2x the
 * limit across a boundary. Blocked requests are counted too (cheap; keeps a flood blocked).
 *
 * Backend errors: auth/sensitive routes FAIL CLOSED (503 + Retry-After); general API routes FAIL OPEN by default
 * (RATE_LIMIT_FAIL_MODE=closed flips them), always with a loud, rate-limited log line and a counter.
 *
 * Exotel endpoints and /health are never throttled: Exotel retries and streams from a handful of IPs, and
 * throttling them would drop real calls. See docs/security/rate-limiting.md.
 */
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getConfig } from "../config/env.js";
import type { RequestContext } from "../auth/context.js";
import { rateLimitBucketsRepository } from "../db/repositories/security.repository.js";
import { ServiceUnavailableError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../runtime/metrics.js";

export class RateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

const EXEMPT_PATHS = [/^\/health$/, /^\/ready$/, /^\/api\/telephony\/exotel\//];

export function isRateLimitExempt(url: string): boolean {
  const path = url.split("?")[0];
  return EXEMPT_PATHS.some((re) => re.test(path));
}

export type FailMode = "open" | "closed";

const hashKey = (scope: string, id: string) => createHash("sha256").update(`rl:${scope}|${id}`).digest("hex");

/* ---- backend failure accounting (bounded: three scalars) ---- */

let backendErrors = 0;
let lastErrorLogAt = 0;
let suppressedSinceLog = 0;
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Counter for monitoring/tests: how many limiter checks failed because the store errored. */
export function getRateLimitBackendErrorCount(): number {
  return backendErrors;
}

function noteBackendError(err: unknown, scope: string, mode: FailMode): void {
  backendErrors++;
  metrics.inc("rate_limit_backend_errors_total", { mode });
  if (mode === "open") metrics.inc("rate_limit_fail_open_total");
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) {
    suppressedSinceLog++;
    return;
  }
  logger.error("rate-limit: counter store unavailable", {
    scope,
    failMode: mode,
    behaviour: mode === "closed" ? "rejecting with 503" : "allowing request WITHOUT rate limiting",
    error: err instanceof Error ? err.message : String(err),
    totalBackendErrors: backendErrors,
    suppressedSinceLastLog: suppressedSinceLog,
  });
  lastErrorLogAt = now;
  suppressedSinceLog = 0;
}

interface Verdict {
  limited: boolean;
  retryAfterSec: number;
}

/**
 * One store round-trip. Returns { limited:false } on a fail-open backend error; throws ServiceUnavailableError on a
 * fail-closed one.
 */
async function consume(scope: string, id: string, max: number, windowMs: number, mode: FailMode): Promise<Verdict> {
  let res: { count: number; retryAfterSec: number };
  try {
    res = await rateLimitBucketsRepository.hit({ key: hashKey(scope, id), windowMs });
  } catch (err) {
    noteBackendError(err, scope, mode);
    if (mode === "closed") {
      throw new ServiceUnavailableError("Rate limiting is temporarily unavailable. Please retry shortly.", "RATE_LIMIT_UNAVAILABLE");
    }
    return { limited: false, retryAfterSec: 0 };
  }
  return res.count > max ? { limited: true, retryAfterSec: res.retryAfterSec } : { limited: false, retryAfterSec: 0 };
}

const generalMode = (): FailMode => getConfig().rateLimit.failMode;

/** Removes expired buckets in bounded batches (called by the security janitor). */
export async function purgeExpiredRateLimitBuckets(now: Date = new Date()): Promise<number> {
  const { apiWindowMs, callsPerOrgWindowMs } = getConfig().rateLimit;
  const keepMs = Math.max(3600_000, 2 * apiWindowMs, 2 * callsPerOrgWindowMs);
  const before = new Date(now.getTime() - keepMs);
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const n = await rateLimitBucketsRepository.deleteExpired({ before, batch: 1000 });
    total += n;
    if (n < 1000) break;
  }
  return total;
}

/** The demo property endpoint lives under the exempt Exotel prefix, so it carries its own per-IP limit. */
export async function enforceDemoApiRateLimit(ip: string, max = 60, windowMs = 60_000): Promise<void> {
  const v = await consume("demo-api", ip, max, windowMs, generalMode());
  if (v.limited) throw new RateLimitError(`Too many requests. Try again in ${v.retryAfterSec} seconds.`, v.retryAfterSec);
}

/**
 * Global per-IP default for the whole API (generous). Registered as an instance-level onRequest hook BEFORE the
 * login gate so unauthenticated and unknown-route floods are counted too. Exempt paths are skipped entirely.
 * Route-specific limits (routeRateLimit below) apply in addition.
 */
export async function globalRateLimitHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isRateLimitExempt(req.url) || req.method === "OPTIONS") return;
  const { apiMax, apiWindowMs } = getConfig().rateLimit;
  const v = await consume(`ip:${apiWindowMs}`, req.ip, apiMax, apiWindowMs, generalMode());
  if (v.limited) {
    reply.header("retry-after", String(v.retryAfterSec));
    throw new RateLimitError(`Too many requests. Try again in ${v.retryAfterSec} seconds.`, v.retryAfterSec);
  }
}

/**
 * Per-user and per-organization ordinary-request budgets for AUTHENTICATED requests. Registered AFTER the login gate
 * (needs req.auth / req.ctx, which come from the verified session), so it can never be dodged by a forged cookie: an
 * unverified cookie leaves req.auth null and only the per-IP limit above applies.
 *
 * Why: every server-rendered dashboard request reaches the API from the web server's address. Unless the real client
 * address is forwarded and trusted (TRUST_PROXY, docs/security/rate-limiting.md), the per-IP budget is shared by all
 * users behind it. These buckets give each user (and each organization) its own budget regardless of source IP, while
 * the per-IP limit stays in force as the abuse ceiling.
 */
export async function authenticatedRateLimitHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth || isRateLimitExempt(req.url) || req.method === "OPTIONS") return;
  const { userMax, orgMax, apiWindowMs } = getConfig().rateLimit;
  const mode = generalMode();
  let v = await consume(`user:${apiWindowMs}`, req.auth.userId, userMax, apiWindowMs, mode);
  if (!v.limited && req.ctx) v = await consume(`org:${apiWindowMs}`, req.ctx.organizationId, orgMax, apiWindowMs, mode);
  if (v.limited) {
    reply.header("retry-after", String(v.retryAfterSec));
    throw new RateLimitError(`Too many requests. Try again in ${v.retryAfterSec} seconds.`, v.retryAfterSec);
  }
}

/**
 * Route-level limit for auth/sensitive routes (preHandler, so the body is parsed and req.auth is set). Always FAILS
 * CLOSED. `key` picks the identifier (IP, IP+email, user id); `name` is part of the hashed scope, so each route has
 * its own budget.
 *   app.post(url, { preHandler: routeRateLimit({ name: "x", max: 10, windowMs: 15 * 60_000, key: (req) => req.ip }) }, handler)
 */
export function routeRateLimit(opts: { name: string; max: number; windowMs: number; key: (req: FastifyRequest) => string }) {
  return async function routeRateLimitPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const v = await consume(`route:${opts.name}`, opts.key(req), opts.max, opts.windowMs, "closed");
    if (v.limited) {
      reply.header("retry-after", String(v.retryAfterSec));
      throw new RateLimitError(`Too many requests. Try again in ${v.retryAfterSec} seconds.`, v.retryAfterSec);
    }
  };
}

/* ---- per-organization call-initiation limit ---- */

/** Fixed window. Throws RateLimitError (429) when the organization is over its limit. */
export async function enforceCallRateLimit(ctx: RequestContext): Promise<void> {
  const { callsPerOrgMax: max, callsPerOrgWindowMs: windowMs } = getConfig().rateLimit;
  const v = await consume("org-calls", ctx.organizationId, max, windowMs, generalMode());
  if (v.limited) {
    throw new RateLimitError(
      `Call limit reached: at most ${max} calls per ${Math.round(windowMs / 1000)} seconds per organization. Try again in ${v.retryAfterSec} seconds.`,
      v.retryAfterSec,
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
    await enforceCallRateLimit(req.ctx);
  } catch (err) {
    if (err instanceof RateLimitError) reply.header("retry-after", String(err.retryAfterSeconds));
    throw err;
  }
}

/** Test helper: clears every shared counter. */
export async function resetCallRateLimits(): Promise<void> {
  await rateLimitBucketsRepository.deleteAll();
}
