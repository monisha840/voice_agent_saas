/** Rate limiting: global per-IP default, Exotel/health exemption, login limit intact, per-organization call limit. */
import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../app.js";
import {
  callRateLimitPreHandler,
  enforceCallRateLimit,
  getRateLimitBackendErrorCount,
  purgeExpiredRateLimitBuckets,
  resetCallRateLimits,
  RateLimitError,
} from "./rate-limits.js";
import { rateLimitBucketsRepository } from "../db/repositories/security.repository.js";
import { db } from "../db/client.js";
import { sql } from "drizzle-orm";
import { userContext } from "../auth/context.js";
import { cleanupTenants, createTenant, loginCookie } from "../test/tenants.js";

const ENV_KEYS = ["RATE_LIMIT_FAIL_MODE", "RATE_LIMIT_API_MAX", "RATE_LIMIT_API_WINDOW_MS", "RATE_LIMIT_CALLS_PER_ORG_MAX", "RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS"];

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
  await resetCallRateLimits();
  await db.execute(sql`delete from auth_throttle`); // login throttle is shared state too
  await cleanupTenants();
});

async function listening(app: Awaited<ReturnType<typeof buildApp>>) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

describe("global per-IP limit", () => {
  it("returns 429 with the uniform error shape after the threshold, and never throttles Exotel or /health", async () => {
    process.env.RATE_LIMIT_API_MAX = "5";
    process.env.RATE_LIMIT_API_WINDOW_MS = "60011"; // the window is part of the key: a bucket no parallel test file touches
    const app = await buildApp();
    const baseUrl = await listening(app);
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 8; i++) {
        last = await fetch(`${baseUrl}/api/projects`); // 401s still count against the IP
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
      const body = (await last!.json()) as { error: string };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toMatch(/too many requests/i);
      expect(last!.headers.get("retry-after")).toBeTruthy();

      // Burst well past the limit: exempt endpoints are never throttled.
      for (let i = 0; i < 30; i++) {
        expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, { method: "POST" })).status).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps the stricter login limit (10 per IP+email) ahead of the global default", async () => {
    const app = await buildApp();
    const baseUrl = await listening(app);
    try {
      const attempt = () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-1" }),
        });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await attempt()).status);
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
      // The throttled answer carries a machine-readable code and a Retry-After, and nothing else.
      const throttled = await attempt();
      expect(throttled.status).toBe(429);
      expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Object.keys((await throttled.json()) as object).sort()).toEqual(["code", "error"]);
    } finally {
      await app.close();
    }
  });
});

describe("per-organization call limit", () => {
  it("429s one organization at its limit without affecting another", async () => {
    process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = "3";
    const A = await createTenant("A");
    const B = await createTenant("B");
    const app = await buildApp();
    // Mirrors how leads.routes wires it into POST /api/leads/:id/call.
    app.post("/api/test-call", { preHandler: callRateLimitPreHandler }, async () => ({ ok: true }));
    const baseUrl = await listening(app);
    try {
      const cookieA = await loginCookie(baseUrl, A.email);
      const cookieB = await loginCookie(baseUrl, B.email);
      const call = (cookie: string) => fetch(`${baseUrl}/api/test-call`, { method: "POST", headers: { cookie } });

      for (let i = 0; i < 3; i++) expect((await call(cookieA)).status).toBe(200);
      const blocked = await call(cookieA);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      const body = (await blocked.json()) as { error: string };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toMatch(/call limit reached/i);

      // B is untouched even though A is blocked (same IP, different organization).
      for (let i = 0; i < 3; i++) expect((await call(cookieB)).status).toBe(200);
      expect((await call(cookieB)).status).toBe(429);
      expect((await call(cookieA)).status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("uses a fixed window that resets once it expires", async () => {
    process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = "2";
    process.env.RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS = "1000";
    const ctx = userContext("org-x", "user-1", "OWNER");
    await enforceCallRateLimit(ctx);
    await enforceCallRateLimit(ctx);
    await expect(enforceCallRateLimit(ctx)).rejects.toBeInstanceOf(RateLimitError);
    await expect(enforceCallRateLimit(userContext("org-y", "user-2", "OWNER"))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 1150));
    await expect(enforceCallRateLimit(ctx)).resolves.toBeUndefined(); // window expired: counter restarted
    await enforceCallRateLimit(ctx);
    await expect(enforceCallRateLimit(ctx)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("shared store (two API instances, one database)", () => {
  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("shares the per-IP counter: hits on instance A count against instance B", async () => {
    process.env.RATE_LIMIT_API_MAX = "5";
    process.env.RATE_LIMIT_API_WINDOW_MS = "60013";
    const a = await buildApp();
    const b = await buildApp();
    const urlA = await listening(a);
    const urlB = await listening(b);
    try {
      for (let i = 0; i < 3; i++) expect((await fetch(`${urlA}/api/projects`)).status).toBe(401);
      for (let i = 0; i < 2; i++) expect((await fetch(`${urlB}/api/projects`)).status).toBe(401);
      expect((await fetch(`${urlA}/api/projects`)).status).toBe(429);
      const blocked = await fetch(`${urlB}/api/projects`);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await fetch(`${urlB}/health`)).status).toBe(200);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("login limits cannot be bypassed by alternating instances", async () => {
    const a = await buildApp();
    const b = await buildApp();
    const urls = [await listening(a), await listening(b)];
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) {
        statuses.push((await post(urls[i % 2], "/api/auth/login", { email: "nobody@example.test", password: "wrong-password-1" })).status);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("accept-invite's per-IP route limit (10) is shared across instances", async () => {
    const a = await buildApp();
    const b = await buildApp();
    const urls = [await listening(a), await listening(b)];
    try {
      // Other test files may already have used this IP's 15-minute budget, so assert on the shape, not exact counts.
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await post(urls[i % 2], "/api/auth/accept-invite", {})).status);
      const first429 = statuses.indexOf(429);
      expect(first429).toBeGreaterThan(-1);
      expect(first429).toBeLessThanOrEqual(10);
      expect(statuses.slice(0, first429).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(first429).every((s) => s === 429)).toBe(true); // both instances refuse after the shared limit
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("is atomic under concurrency and stores only hashed keys", async () => {
    const hit = vi.spyOn(rateLimitBucketsRepository, "hit");
    process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = "5";
    const ctx = userContext("org-concurrent", "u", "OWNER");
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => enforceCallRateLimit(ctx)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(15);

    const app = await buildApp();
    const url = await listening(app);
    try {
      await post(url, "/api/auth/login", { email: "Secret.Person@example.test", password: "wrong-password-1" });
    } finally {
      await app.close();
    }
    const keys = hit.mock.calls.map((c) => c[0].key);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    const rows = (await db.execute(sql`select key from rate_limit_buckets`)) as unknown as Array<{ key: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps no per-key state in process memory", () => {
    const src = readFileSync(new URL("./rate-limits.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new (Map|Set|WeakMap)\b/);
  });

  it("purges expired buckets in batches", async () => {
    await rateLimitBucketsRepository.hit({ key: "a".repeat(64), windowMs: 1000 });
    await db.execute(sql`update rate_limit_buckets set window_start = now() - interval '3 hours'`);
    await rateLimitBucketsRepository.hit({ key: "b".repeat(64), windowMs: 1000 });
    expect(await purgeExpiredRateLimitBuckets()).toBe(1);
    const left = (await db.execute(sql`select key from rate_limit_buckets`)) as unknown as unknown[];
    expect(left).toHaveLength(1);
  });

  describe("backend outage", () => {
    it("general routes fail OPEN by default (counted and logged), auth routes fail CLOSED with Retry-After", async () => {
      vi.spyOn(rateLimitBucketsRepository, "hit").mockRejectedValue(new Error("db down"));
      const before = getRateLimitBackendErrorCount();
      const app = await buildApp();
      const url = await listening(app);
      try {
        expect((await fetch(`${url}/api/projects`)).status).toBe(401); // limiter skipped, normal handling
        expect(getRateLimitBackendErrorCount()).toBeGreaterThan(before);
        const authRes = await post(url, "/api/auth/accept-invite", {});
        expect(authRes.status).toBe(503);
        expect(authRes.headers.get("retry-after")).toBeTruthy();
        const login = await post(url, "/api/auth/login", { email: "x@example.test", password: "wrong-password-1" });
        expect(login.status).toBe(503);
        expect((await fetch(`${url}/health`)).status).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("RATE_LIMIT_FAIL_MODE=closed makes general routes 503 too", async () => {
      process.env.RATE_LIMIT_FAIL_MODE = "closed";
      vi.spyOn(rateLimitBucketsRepository, "hit").mockRejectedValue(new Error("db down"));
      const app = await buildApp();
      const url = await listening(app);
      try {
        const res = await fetch(`${url}/api/projects`);
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBeTruthy();
        expect((await res.json()) as { code: string }).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
        expect((await fetch(`${url}/health`)).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  });
});
