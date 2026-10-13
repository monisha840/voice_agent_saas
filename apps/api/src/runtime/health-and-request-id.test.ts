/**
 * Readiness, liveness, and request ids. Uses app.inject (no listening socket); only /ready's default check touches
 * the real test database.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";

import { buildApp } from "../app.js";
import { lifecycle } from "./lifecycle.js";
import { callsService } from "../modules/calls/calls.service.js";
import { logger } from "../shared/logger.js";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});
afterEach(() => {
  lifecycle.reset();
  vi.restoreAllMocks();
});

describe("readiness", () => {
  it("/ready is 200 with the database up, and needs no login", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", draining: false, liveCalls: 0, checks: { database: "ok" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("/ready is 503 when a dependency check fails, without leaking the error text", async () => {
    const broken = await buildApp({
      readinessChecks: [
        {
          name: "database",
          check: async () => {
            throw new Error("password authentication failed for user secret_user");
          },
        },
      ],
    });
    const res = await broken.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { database: "fail" } });
    expect(res.body).not.toContain("secret_user");
    // Liveness is independent of dependencies: a database blip must not get the process restarted.
    expect((await broken.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await broken.close();
  });

  it("/ready is 503 when a check hangs (it times out)", async () => {
    const hanging = await buildApp({ readinessChecks: [{ name: "database", check: () => new Promise<void>(() => undefined) }] });
    const res = await hanging.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe("fail");
    await hanging.close();
  }, 15_000);

  it("/ready turns 503 as soon as shutdown starts, while /health stays 200 and live calls are counted", async () => {
    const unregister = lifecycle.registerSession({ callId: "live-1", close: () => undefined });
    lifecycle.beginDrain();
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", draining: true, liveCalls: 1 });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    unregister();
  });

  it("/ready and /health are reachable through a proxy (load balancers), while dashboard APIs still are not", async () => {
    const viaProxy = { "x-forwarded-for": "203.0.113.9", host: "api.example.com" };
    expect((await app.inject({ method: "GET", url: "/ready", headers: viaProxy })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health", headers: viaProxy })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/calls", headers: viaProxy })).statusCode).toBe(404);
  });

  it("/ready is not throttled by the per-IP rate limit", async () => {
    process.env.RATE_LIMIT_API_MAX = "2";
    const limited = await buildApp();
    for (let i = 0; i < 10; i++) expect((await limited.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await limited.close();
    delete process.env.RATE_LIMIT_API_MAX;
  });
});

describe("request ids", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("every response carries an X-Request-Id, including 401 and 404", async () => {
    for (const url of ["/health", "/api/calls", "/nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["x-request-id"], url).toMatch(UUID);
    }
  });

  it("a sane incoming X-Request-Id is kept, so a proxy's id carries through", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "edge-7f3a9c21-trace" } });
    expect(res.headers["x-request-id"]).toBe("edge-7f3a9c21-trace");
  });

  it("a malformed incoming id (too short, spaces, header-injection characters) is replaced, never echoed", async () => {
    for (const bad of ["x", "has spaces in it", "evil\r\nSet-Cookie: a=b", "a".repeat(200)]) {
      const res = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": bad } });
      expect(res.headers["x-request-id"], bad).toMatch(UUID);
    }
  });

  it("a 5xx error body carries the request id (and nothing internal); 4xx bodies are unchanged", async () => {
    vi.spyOn(callsService, "applyProviderStatus").mockRejectedValue(new Error("connection to 10.1.2.3:5432 refused"));
    const res = await app.inject({
      method: "POST",
      url: "/api/telephony/exotel/status-callback",
      payload: { providerCallId: "x-call", status: "completed" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal server error", requestId: res.headers["x-request-id"] });
    expect(res.body).not.toContain("10.1.2.3");

    const unauthenticated = await app.inject({ method: "GET", url: "/api/calls" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: "Authentication required" });
  });

  it("log lines written while serving a request carry its id, even from deep inside the code", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    vi.spyOn(console, "error").mockImplementation((l: string) => void lines.push(l));
    vi.spyOn(callsService, "applyProviderStatus").mockImplementation(async () => {
      logger.info("probe from inside the service layer");
      throw new Error("boom");
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/telephony/exotel/status-callback",
      headers: { "x-request-id": "trace-abc-12345678" },
      payload: { providerCallId: "x-call", status: "completed" },
    });
    expect(res.statusCode).toBe(500);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.find((l) => l.message === "probe from inside the service layer")?.requestId).toBe("trace-abc-12345678");
    expect(parsed.find((l) => l.message === "unhandled error")?.requestId).toBe("trace-abc-12345678");
  });

  it("log lines outside any request have no request id", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    logger.info("startup line");
    expect(JSON.parse(lines[0])).not.toHaveProperty("requestId");
  });
});
