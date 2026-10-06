/** Rate limiting: global per-IP default, Exotel/health exemption, login limit intact, per-organization call limit. */
import { describe, it, expect, afterEach } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../app.js";
import { callRateLimitPreHandler, enforceCallRateLimit, resetCallRateLimits, RateLimitError } from "./rate-limits.js";
import { userContext } from "../auth/context.js";
import { cleanupTenants, createTenant, loginCookie } from "../test/tenants.js";

const ENV_KEYS = ["RATE_LIMIT_API_MAX", "RATE_LIMIT_CALLS_PER_ORG_MAX", "RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS"];

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetCallRateLimits();
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
      for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect(Object.keys((await (await attempt()).json()) as object)).toEqual(["error"]);
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

  it("uses a sliding window, so capacity returns as old calls age out", () => {
    process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = "2";
    process.env.RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS = "1000";
    const ctx = userContext("org-x", "user-1", "OWNER");
    enforceCallRateLimit(ctx, 0);
    enforceCallRateLimit(ctx, 100);
    expect(() => enforceCallRateLimit(ctx, 200)).toThrow(RateLimitError);
    expect(() => enforceCallRateLimit(ctx, 1050)).not.toThrow(); // first hit aged out
    expect(() => enforceCallRateLimit(ctx, 1060)).toThrow(RateLimitError);
    expect(() => enforceCallRateLimit(userContext("org-y", "user-2", "OWNER"), 1060)).not.toThrow();
  });
});
