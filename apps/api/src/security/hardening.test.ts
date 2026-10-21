/**
 * HTTP hardening: security headers, uniform errors, body limit, no stack
 * traces, log redaction, and regression checks for the webhook secret,
 * public-access guard and CSRF origin check.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Writable } from "node:stream";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.BODY_LIMIT_BYTES = "2048";

import { buildApp } from "../app.js";
import { logger, scrubFields } from "../shared/logger.js";
import { isPublicRequest } from "./telephony-auth.js";
import { cleanupTenants, createTenant, loginCookie, TEST_PASSWORD, type TestTenant } from "../test/tenants.js";

const WEBHOOK_SECRET = "whsec-super-secret-value-42";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let cookie: string;
const logLines: string[] = [];

beforeAll(async () => {
  A = await createTenant("A");
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  app = await buildApp({ logStream: sink });
  app.get("/api/boom", async () => {
    throw new Error("kaboom: db password is hunter2 at C:\\secret\\path.ts");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookie = await loginCookie(baseUrl, A.email);
});

afterAll(async () => {
  await app.close();
  await cleanupTenants();
});

afterEach(() => {
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
});

describe("security headers", () => {
  it("are present on success, error and 404 responses", async () => {
    for (const res of [
      await fetch(`${baseUrl}/health`),
      await fetch(`${baseUrl}/api/projects`, { headers: { cookie } }),
      await fetch(`${baseUrl}/api/projects`), // 401
      await fetch(`${baseUrl}/nope`), // 404
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("omits HSTS on plain-http development", async () => {
    expect((await fetch(`${baseUrl}/health`)).headers.get("strict-transport-security")).toBeNull();
  });

  it("sends HSTS when cookies are secure", async () => {
    process.env.COOKIE_SECURE = "true";
    const secure = await buildApp();
    delete process.env.COOKIE_SECURE;
    const res = await secure.inject({ method: "GET", url: "/health" });
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    await secure.close();
  });
});

describe("uniform errors", () => {
  it("unknown route -> JSON 404", async () => {
    const res = await fetch(`${baseUrl}/health/nope`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("known path with the wrong method -> JSON 405 with Allow", async () => {
    const res = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("an unexpected error is a generic 500 with no stack or internals", async () => {
    const res = await fetch(`${baseUrl}/api/boom`, { headers: { cookie } });
    const text = await res.text();
    expect(res.status).toBe(500);
    // Generic message plus the request id (also in the X-Request-Id header and the server log) so it can be quoted.
    expect(JSON.parse(text)).toEqual({ error: "Internal server error", requestId: res.headers.get("x-request-id") });
    expect(text).not.toMatch(/kaboom|hunter2|secret|\.ts|at .*\(/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("an oversized body is rejected with 413 and the uniform shape", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.test", password: "x".repeat(5000) }),
    });
    expect(res.status).toBe(413);
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
  });
});

describe("log redaction", () => {
  it("never writes the webhook token, session cookie, password or Authorization header to request logs", async () => {
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    logLines.length = 0;
    const sessionValue = cookie.split("=")[1];
    await fetch(`${baseUrl}/api/telephony/exotel/status-callback?token=${WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic dXNlcjp3aHNlYy1zdXBlci1zZWNyZXQtdmFsdWUtNDI=" },
      body: JSON.stringify({}),
    });
    await fetch(`${baseUrl}/api/telephony/exotel/status-callback?token=wrong-token-value`, { method: "POST" });
    await fetch(`${baseUrl}/api/projects`, { headers: { cookie, authorization: "Bearer bearer-secret-123" } });
    await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: A.email, password: "not-the-password-xyz" }),
    });
    await fetch(`${baseUrl}/api/boom`, { headers: { cookie } });
    const all = logLines.join("");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [WEBHOOK_SECRET, "wrong-token-value", sessionValue, TEST_PASSWORD, "not-the-password-xyz", "bearer-secret-123", "dXNlcjp3aHNlYy"]) {
      expect(all, secret).not.toContain(secret);
    }
    expect(all).toContain("[redacted]"); // the token query was logged in redacted form
  });

  it("the app logger masks secret keys and secrets embedded in strings", () => {
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    logger.info("calling https://x.test/ws?token=abc123secret&a=1", {
      password: "pw-secret",
      headers: { authorization: "Bearer tok-secret", cookie: "va_session=sess-secret" },
      nested: { apiKey: "key-secret", note: "Basic dXNlcjpwYXNz and va_session=sess2-secret" },
    });
    logger.error("boom", { error: "failed for ?token=err-secret", stack: "x" });
    const out = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join("\n");
    spies.forEach((s) => s.mockRestore());
    for (const secret of ["abc123secret", "pw-secret", "tok-secret", "sess-secret", "key-secret", "dXNlcjpwYXNz", "sess2-secret", "err-secret"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("a=1");
    expect(JSON.stringify(scrubFields({ a: [{ secretKey: "x" }] }))).not.toContain('"x"');
  });
});

describe("earlier protections are intact", () => {
  it("Exotel status callback is reachable without a login", async () => {
    const res = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, { method: "POST" });
    expect(res.status).toBe(200); // mock provider, no secret configured
  });

  it("with a secret configured: wrong token -> 401, right token -> 200, Basic password accepted", async () => {
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const url = `${baseUrl}/api/telephony/exotel/status-callback`;
    expect((await fetch(`${url}?token=nope`, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}?token=${WEBHOOK_SECRET}`, { method: "POST" })).status).toBe(200);
    const basic = Buffer.from(`exotel:${WEBHOOK_SECRET}`).toString("base64");
    expect((await fetch(url, { method: "POST", headers: { authorization: `Basic ${basic}` } })).status).toBe(200);
  });

  it("tunnel-style requests still 404 on dashboard APIs but reach /health and Exotel", async () => {
    const tunnel = { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "abc.ngrok.app", cookie };
    expect((await fetch(`${baseUrl}/api/projects`, { headers: tunnel })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/audit-logs`, { headers: tunnel })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/usage/summary`, { headers: tunnel })).status).toBe(404);
    expect((await fetch(`${baseUrl}/health`, { headers: tunnel })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, { method: "POST", headers: tunnel })).status).toBe(200);
  });

  it("isPublicRequest treats x-forwarded-* as public regardless of TRUST_PROXY", () => {
    process.env.TRUST_PROXY = "true";
    try {
      expect(isPublicRequest({ headers: { host: "127.0.0.1:4000", "x-forwarded-for": "1.2.3.4" } })).toBe(true);
      expect(isPublicRequest({ headers: { host: "127.0.0.1:4000" } })).toBe(false);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it("CSRF: a cookie-authenticated unsafe request from a foreign origin is refused", async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-origin request blocked" });
  });
});
