/**
 * Metrics registry, GET /metrics access control, and that each instrumented trigger moves its counter.
 * Real Postgres where the trigger touches it (security events, janitor); failures are simulated by spying on repos.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";

import { buildApp } from "../app.js";
import { metrics, isDbAuthorizationError } from "./metrics.js";
import { enforceDemoApiRateLimit, resetCallRateLimits } from "../security/rate-limits.js";
import { authenticateMediaStream } from "../security/stream-auth.js";
import { securityEvents } from "../security/security-events.js";
import {
  rateLimitBucketsRepository,
  securityEventRetentionRepository,
  securityEventsRepository,
} from "../db/repositories/security.repository.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";
import { runSecurityEventRetentionOnce, runSecurityJanitorOnce } from "./security-janitor.js";

const TOKEN = "metrics-token-0123456789-abcdef";
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

beforeAll(async () => {
  process.env.METRICS_TOKEN = TOKEN;
  app = await buildApp();
  // A path the login gate lets through (public Exotel prefix), so the central error handler is what runs.
  app.get("/api/telephony/exotel/__boom/:kind", async (req) => {
    const kind = (req.params as { kind: string }).kind;
    if (kind === "42501") throw Object.assign(new Error("permission denied for table calls"), { code: "42501", name: "PostgresError" });
    if (kind === "rls") throw new Error('new row violates row-level security policy for table "calls"');
    if (kind === "wrapped") throw Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("x"), { code: "42501" }) });
    throw new Error("unrelated failure");
  });
  await app.ready();
});
afterAll(async () => {
  delete process.env.METRICS_TOKEN;
  await app.close();
});
beforeEach(() => metrics.reset());
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SECURITY_EVENT_RETENTION_ENABLED;
  delete process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF;
  delete process.env.SECURITY_EVENT_RETENTION_BATCH_SIZE;
  delete process.env.RATE_LIMIT_FAIL_MODE;
  await resetCallRateLimits();
});

const scrape = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}`, ...headers } });

describe("registry", () => {
  it("renders Prometheus text, bounds label cardinality and sanitises label values", () => {
    for (let i = 0; i < 200; i++) metrics.inc("stream_auth_denied_total", { reason: `r${i}` });
    metrics.inc("stream_auth_denied_total", { reason: "a@b.com" });
    metrics.inc("stream_auth_denied_total", { reason: "10.1.2.3 with spaces" });
    const out = metrics.render();
    const lines = out.split("\n").filter((l) => l.startsWith("stream_auth_denied_total{"));
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(out).not.toMatch(/a@b\.com|10\.1\.2\.3/);
    expect(out).toContain('stream_auth_denied_total{reason="other"}');
    expect(out).toMatch(/# TYPE rate_limit_fail_open_total counter/);
    expect(() => metrics.inc("stream_auth_denied_total", { ip: "1.2.3.4" })).toThrow();
  });

  it("recognises database authorization errors, including wrapped causes", () => {
    expect(isDbAuthorizationError(Object.assign(new Error("x"), { code: "42501" }))).toBe(true);
    expect(isDbAuthorizationError(new Error("violates row-level security policy"))).toBe(true);
    expect(isDbAuthorizationError(new Error("Permission denied for table x"))).toBe(true);
    expect(isDbAuthorizationError({ cause: { code: "42501" } })).toBe(true);
    expect(isDbAuthorizationError(new Error("connection refused"))).toBe(false);
  });
});

describe("GET /metrics access", () => {
  it("is 404 without a token configured", async () => {
    delete process.env.METRICS_TOKEN;
    try {
      expect((await scrape()).statusCode).toBe(404);
    } finally {
      process.env.METRICS_TOKEN = TOKEN;
    }
  });
  it("treats a too-short token as unset", async () => {
    process.env.METRICS_TOKEN = "short";
    try {
      expect((await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer short" } })).statusCode).toBe(404);
    } finally {
      process.env.METRICS_TOKEN = TOKEN;
    }
  });
  it("401 without or with a wrong token, and no query-string token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await scrape({ authorization: "Bearer wrong-token-0123456789-abcdef" })).statusCode).toBe(401);
    expect((await scrape({ authorization: `Basic ${TOKEN}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/metrics?token=${TOKEN}` })).statusCode).toBe(401);
  });
  it("200 text/plain with the right token on a private host", async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("# TYPE db_authorization_errors_total counter");
  });
  it("404 for public hosts and proxied requests even with the right token", async () => {
    expect((await scrape({ host: "api.example.com" })).statusCode).toBe(404);
    expect((await scrape({ "x-forwarded-for": "203.0.113.9" })).statusCode).toBe(404);
  });
});

describe("counters move on their trigger", () => {
  it("rate-limit backend failure (fail open and fail closed)", async () => {
    vi.spyOn(rateLimitBucketsRepository, "hit").mockRejectedValue(new Error("db down"));
    await enforceDemoApiRateLimit("198.51.100.7"); // general route, default fail-open
    expect(metrics.get("rate_limit_backend_errors_total", { mode: "open" })).toBe(1);
    expect(metrics.get("rate_limit_fail_open_total")).toBe(1);
    process.env.RATE_LIMIT_FAIL_MODE = "closed";
    await expect(enforceDemoApiRateLimit("198.51.100.7")).rejects.toThrow();
    expect(metrics.get("rate_limit_backend_errors_total", { mode: "closed" })).toBe(1);
    expect(metrics.get("rate_limit_fail_open_total")).toBe(1);
  });

  it("denied stream token, by reason, without the token or ip in the output", async () => {
    vi.spyOn(securityEventsRepository, "insert").mockResolvedValue(undefined as never);
    const secretish = "eyJhbGciOiJIUzI1NiJ9.SECRETPAYLOAD.sig";
    const res = await authenticateMediaStream({ query: { st: secretish }, headers: {}, ip: "203.0.113.5" } as never);
    expect(res).toBeNull();
    const out = metrics.render();
    const m = out.match(/stream_auth_denied_total\{reason="([^"]+)"\} 1/);
    expect(m?.[1]).toMatch(/^token_/);
    expect(out).not.toMatch(/SECRETPAYLOAD|203\.0\.113\.5/);
  });

  it("db authorization errors seen by the central error handler (but not unrelated 500s)", async () => {
    for (const k of ["42501", "rls", "wrapped"]) {
      const res = await app.inject({ method: "GET", url: `/api/telephony/exotel/__boom/${k}` });
      expect(res.statusCode).toBe(500);
    }
    expect(metrics.get("db_authorization_errors_total")).toBe(3);
    await app.inject({ method: "GET", url: "/api/telephony/exotel/__boom/other" });
    expect(metrics.get("db_authorization_errors_total")).toBe(3);
  });

  it("retention failure and purged counts", async () => {
    process.env.SECURITY_EVENT_RETENTION_ENABLED = "true";
    process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF = "TEST-POLICY-APPROVAL";
    vi.spyOn(securityEventRetentionRepository, "purge").mockRejectedValue(new Error("boom"));
    const r = await runSecurityEventRetentionOnce();
    expect(r.error).toBeTruthy();
    expect(metrics.get("security_event_retention_errors_total")).toBe(1);
    expect(metrics.get("security_janitor_failures_total", { task: "retention" })).toBe(1);

    vi.restoreAllMocks();
    vi.spyOn(securityEventRetentionRepository, "purge").mockResolvedValue({ other: 3 });
    vi.spyOn(securityEventsRepository, "insert").mockResolvedValue(undefined as never);
    process.env.SECURITY_EVENT_RETENTION_BATCH_SIZE = "100"; // 3 < batch: one batch, then drained
    await runSecurityEventRetentionOnce();
    expect(metrics.get("security_event_retention_purged_total")).toBe(3);
  });

  it("janitor cleanup failure, and last-success gauge on success", async () => {
    vi.spyOn(sessionsRepository, "deleteExpired").mockRejectedValue(new Error("hiccup"));
    await expect(runSecurityJanitorOnce()).rejects.toThrow("hiccup");
    expect(metrics.get("security_janitor_failures_total", { task: "cleanup" })).toBe(1);
    expect(metrics.get("security_janitor_last_success_timestamp_seconds")).toBe(0);
    vi.restoreAllMocks();
    await runSecurityJanitorOnce();
    expect(metrics.get("security_janitor_last_success_timestamp_seconds")).toBeGreaterThan(1_700_000_000);
  });

  it("security-event persistence failure and throttle denials", async () => {
    vi.spyOn(securityEventsRepository, "insert").mockRejectedValue(new Error("write failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await securityEvents.record({ type: "auth.login.throttled", outcome: "denied", ip: "192.0.2.1" });
    await securityEvents.record({ type: "auth.mfa.throttled", outcome: "denied" });
    expect(metrics.get("security_event_persist_failures_total")).toBe(2);
    expect(metrics.get("auth_throttle_denied_total", { kind: "login" })).toBe(1);
    expect(metrics.get("auth_throttle_denied_total", { kind: "mfa" })).toBe(1);
  });

  it("scraped output carries no ip, email or token", async () => {
    vi.spyOn(securityEventsRepository, "insert").mockRejectedValue(new Error("write failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await securityEvents.record({
      type: "auth.login.throttled",
      outcome: "denied",
      ip: "192.0.2.77",
      metadata: { email: "victim@example.com" },
    });
    const body = (await scrape()).body;
    expect(body).not.toMatch(/192\.0\.2\.77|victim@example\.com|metrics-token/);
  });
});
