/**
 * GET /metrics over a REAL listening socket (node:http client, arbitrary Host / X-Forwarded-* headers), not inject().
 * Covers: no token -> 404, public Host / proxy headers -> 404 (even with the right token), missing/wrong token -> 401,
 * right token -> 200 Prometheus content type, the token never reaches logs or the response body of failures, the
 * comparison is length-independent (digest based), and the endpoint is NOT exempt from the global rate limit.
 */
import { Writable } from "node:stream";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";

import { buildApp } from "../app.js";
import { isRateLimitExempt } from "../security/rate-limits.js";

const TOKEN = "socket-metrics-token-0123456789-abcdef";
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let port = 0;
const logged: string[] = [];

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(path: string, headers: Record<string, string> = {}, host?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { ...(host ? { host } : {}), ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  process.env.METRICS_TOKEN = TOKEN;
  process.env.API_PRIVATE_HOSTS = "api.internal.test";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logged.push(String(chunk));
      cb();
    },
  });
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  app = await buildApp({ logStream: sink } as never);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(async () => {
  delete process.env.METRICS_TOKEN;
  delete process.env.API_PRIVATE_HOSTS;
  vi.restoreAllMocks();
  await app?.close();
});

describe("GET /metrics over a real socket", () => {
  it("200 with the right token on localhost, Prometheus content type, no-store", async () => {
    const r = await get("/metrics", auth());
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain("# TYPE rate_limit_fail_open_total counter");
    expect(r.body).toContain('rate_limit_backend_errors_total{mode="open"} ');
  });

  it("200 on an operator-listed private hostname (API_PRIVATE_HOSTS)", async () => {
    expect((await get("/metrics", auth(), "api.internal.test:3001")).status).toBe(200);
  });

  it("401 for a missing, wrong, differently-long, or wrong-scheme token; no token echoed", async () => {
    const cases: Record<string, string>[] = [
      {},
      auth("wrong-token-0123456789-abcdef-xx"),
      auth("x"),
      auth(TOKEN + "extra"),
      auth(TOKEN.slice(0, -1)),
      { authorization: `Basic ${TOKEN}` },
      { authorization: TOKEN },
    ];
    for (const h of cases) {
      const r = await get("/metrics", h);
      expect(r.status, JSON.stringify(h)).toBe(401);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
      expect(r.body).not.toContain(TOKEN);
    }
    expect((await get(`/metrics?token=${TOKEN}`)).status).toBe(401);
  });

  it("404 for public Host and proxy/tunnel headers even with the right token", async () => {
    expect((await get("/metrics", auth(), "api.example.com")).status).toBe(404);
    expect((await get("/metrics", { ...auth(), "x-forwarded-for": "203.0.113.9" })).status).toBe(404);
    expect((await get("/metrics", { ...auth(), "x-forwarded-host": "api.example.com" })).status).toBe(404);
    expect((await get("/metrics", { ...auth(), forwarded: "for=203.0.113.9;host=api.example.com" })).status).toBe(404);
    const r = await get("/metrics", auth(), "api.example.com");
    expect(r.body).not.toMatch(/# TYPE/);
  });

  it("404 when no (or a too-short) token is configured, even with a header presented", async () => {
    for (const value of [undefined, "", "short"]) {
      if (value === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = value;
      try {
        expect((await get("/metrics", auth(value ?? "none"))).status).toBe(404);
        expect((await get("/metrics")).status).toBe(404);
      } finally {
        process.env.METRICS_TOKEN = TOKEN;
      }
    }
  });

  it("is NOT exempt from the global per-IP rate limit (documented behaviour)", () => {
    expect(isRateLimitExempt("/metrics")).toBe(false);
    expect(isRateLimitExempt("/metrics?x=1")).toBe(false);
    expect(isRateLimitExempt("/health")).toBe(true);
  });

  it("the token never appears in any log line written during these requests", async () => {
    await get("/metrics", auth());
    await get("/metrics", auth("wrong-token-0123456789-abcdef-xx"));
    await get(`/metrics?token=${TOKEN}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
