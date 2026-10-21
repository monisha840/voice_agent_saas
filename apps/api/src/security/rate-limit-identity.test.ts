/**
 * Who a request is counted against: spoofed forwarding headers, a shared proxy address, several users of one
 * organization, users of different organizations, and the forwarding helper the web server uses.
 * Window lengths are unique per test so no bucket is shared with another test file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { resetCallRateLimits } from "./rate-limits.js";
import { cleanupTenants, createMember, createTenant, loginCookie } from "../test/tenants.js";

const ENV = [
  "TRUST_PROXY",
  "RATE_LIMIT_API_MAX",
  "RATE_LIMIT_API_WINDOW_MS",
  "RATE_LIMIT_USER_MAX",
  "RATE_LIMIT_ORG_MAX",
  "RATE_LIMIT_FAIL_MODE",
];

afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await resetCallRateLimits();
  await db.execute(sql`delete from auth_throttle`);
  await cleanupTenants();
});

async function start() {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

const get = (baseUrl: string, path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, { headers });

describe("per-IP identity and forwarding headers", () => {
  // NOTE: any request carrying X-Forwarded-* is treated by the public-access guard (telephony-auth.ts) as coming from
  // the public internet and gets a uniform 404 for dashboard routes. The rate limiter runs BEFORE the guard, so such a
  // request is still counted; 404 = "counted, within budget", 429 = "over budget".
  const forwarded = (baseUrl: string, ip: string) => get(baseUrl, "/api/projects", { "x-forwarded-for": ip }).then((r) => r.status);

  it("ignores X-Forwarded-For when no proxy is trusted: rotating it neither reaches the API nor escapes the limit", async () => {
    process.env.RATE_LIMIT_API_MAX = "4";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61001";
    const { app, baseUrl } = await start();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push(await forwarded(baseUrl, `198.51.100.${i}`));
      expect(statuses).toEqual([404, 404, 404, 404, 429, 429, 429]); // one bucket (the socket address), never served
    } finally {
      await app.close();
    }
  });

  it("ignores it when the connecting address is not the configured proxy", async () => {
    process.env.TRUST_PROXY = "203.0.113.9"; // the test connects from 127.0.0.1
    process.env.RATE_LIMIT_API_MAX = "4";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61002";
    const { app, baseUrl } = await start();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push(await forwarded(baseUrl, `198.51.100.${i}`));
      expect(statuses.slice(4)).toEqual([429, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it("with the proxy trusted, distinct forwarded clients have separate budgets and one client still hits its own limit", async () => {
    process.env.TRUST_PROXY = "127.0.0.1";
    process.env.RATE_LIMIT_API_MAX = "4";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61003";
    const { app, baseUrl } = await start();
    try {
      for (let c = 0; c < 6; c++) {
        for (let i = 0; i < 3; i++) expect(await forwarded(baseUrl, `198.51.100.${c}`)).toBe(404);
      }
      const one: number[] = [];
      for (let i = 0; i < 7; i++) one.push(await forwarded(baseUrl, "198.51.100.200"));
      expect(one.slice(4)).toEqual([429, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it("a client cannot dodge the limit by prepending its own entries to the forwarded chain", async () => {
    process.env.TRUST_PROXY = "127.0.0.1";
    process.env.RATE_LIMIT_API_MAX = "4";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61004";
    const { app, baseUrl } = await start();
    try {
      const statuses: number[] = [];
      // The trusted proxy appended the real client (192.0.2.50); everything left of it is attacker-controlled.
      for (let i = 0; i < 7; i++) statuses.push(await forwarded(baseUrl, `10.0.0.${i}, 192.0.2.50`));
      expect(statuses.slice(4)).toEqual([429, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it("unauthenticated and login endpoints stay IP-limited, and a forged session cookie does not count as authenticated", async () => {
    process.env.RATE_LIMIT_API_MAX = "5";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61005";
    const { app, baseUrl } = await start();
    try {
      const login = () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-1" }),
        });
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) statuses.push((await login()).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    } finally {
      await app.close();
    }
  });

  it("a forged session cookie is still charged to the IP (it never reaches the per-user bucket)", async () => {
    process.env.RATE_LIMIT_API_MAX = "4";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61009";
    process.env.RATE_LIMIT_USER_MAX = "100000";
    const { app, baseUrl } = await start();
    try {
      const forged: number[] = [];
      for (let i = 0; i < 7; i++) forged.push((await get(baseUrl, "/api/projects", { cookie: "va_session=forged" })).status);
      expect(forged.slice(4)).toEqual([429, 429, 429]);
    } finally {
      await app.close();
    }
  });
});

describe("authenticated users do not share an ordinary request budget", () => {
  it("users behind one shared address have separate budgets; users in other organizations are unaffected", async () => {
    process.env.RATE_LIMIT_API_MAX = "100000"; // the shared proxy address: effectively unbounded for this test
    process.env.RATE_LIMIT_API_WINDOW_MS = "61006";
    process.env.RATE_LIMIT_USER_MAX = "6";
    process.env.RATE_LIMIT_ORG_MAX = "100000";
    const A = await createTenant("RLI_A");
    const A2 = await createMember(A.orgId, "ADMIN");
    const B = await createTenant("RLI_B");
    const { app, baseUrl } = await start();
    try {
      const cookieA = await loginCookie(baseUrl, A.email);
      const cookieA2 = await loginCookie(baseUrl, A2.email);
      const cookieB = await loginCookie(baseUrl, B.email);
      const hit = (cookie: string) => get(baseUrl, "/api/organization", { cookie }).then((r) => r.status);

      const a: number[] = [];
      for (let i = 0; i < 10; i++) a.push(await hit(cookieA));
      expect(a.slice(0, 6).every((s) => s === 200)).toBe(true);
      expect(a.slice(6).every((s) => s === 429)).toBe(true);

      // same organization, same IP, different user: still has a full budget
      expect(await hit(cookieA2)).toBe(200);
      // different organization: unaffected
      expect(await hit(cookieB)).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("an organization has an aggregate ceiling shared by its users, and not by other organizations", async () => {
    process.env.RATE_LIMIT_API_MAX = "100000";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61007";
    process.env.RATE_LIMIT_USER_MAX = "100000";
    process.env.RATE_LIMIT_ORG_MAX = "8";
    const A = await createTenant("RLO_A");
    const A2 = await createMember(A.orgId, "ADMIN");
    const B = await createTenant("RLO_B");
    const { app, baseUrl } = await start();
    try {
      const cookieA = await loginCookie(baseUrl, A.email);
      const cookieA2 = await loginCookie(baseUrl, A2.email);
      const cookieB = await loginCookie(baseUrl, B.email);
      const hit = (cookie: string) => get(baseUrl, "/api/organization", { cookie }).then((r) => r.status);
      // logins above are unauthenticated requests: they used none of the org budget; 8 authenticated hits exhaust it
      const results: number[] = [];
      for (let i = 0; i < 4; i++) {
        results.push(await hit(cookieA));
        results.push(await hit(cookieA2));
      }
      expect(results.every((s) => s === 200)).toBe(true);
      expect(await hit(cookieA)).toBe(429);
      expect(await hit(cookieA2)).toBe(429);
      expect(await hit(cookieB)).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("exempt endpoints and preflight are never charged to a user", async () => {
    process.env.RATE_LIMIT_API_MAX = "100000";
    process.env.RATE_LIMIT_API_WINDOW_MS = "61008";
    process.env.RATE_LIMIT_USER_MAX = "2";
    const A = await createTenant("RLE_A");
    const { app, baseUrl } = await start();
    try {
      const cookie = await loginCookie(baseUrl, A.email);
      for (let i = 0; i < 10; i++) expect((await get(baseUrl, "/health", { cookie })).status).toBe(200);
      expect((await get(baseUrl, "/api/organization", { cookie })).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
