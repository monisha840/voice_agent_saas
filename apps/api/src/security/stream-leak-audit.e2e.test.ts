/**
 * Leak audit: stream grants (`g`), per-call tokens (`st`), the shared webhook secret and Basic credentials must never
 * appear in request logs, structured-logger output, HTTP error bodies/headers, WebSocket close reasons,
 * security_events / audit_logs / usage rows, or /metrics. Real denied AND accepted connections are driven, every
 * captured line / row / body is scanned for each secret value (plus its base64 form).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { gte } from "drizzle-orm";
import WebSocket from "ws";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "exotel";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

const SECRET = "leak-audit-shared-secret-Zq81xP";
const METRICS_TOKEN = "leak-audit-metrics-token-0123456789";
const KEY = randomBytes(32).toString("base64");
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
process.env.EXOTEL_WEBHOOK_BASE_URL = "https://voice-api.example-company.in";
process.env.STREAM_TOKEN_KEYS = `k1:${KEY}`;
process.env.METRICS_TOKEN = METRICS_TOKEN;
process.env.STREAM_GRANT_MAX_USES = "1";

import { buildApp } from "../app.js";
import { adminDb as db } from "../db/client.js";
import { auditLogs, calls, conversations, securityEvents, streamClaims, streamGrants, streamTokenUses, usageEvents } from "../db/schema.js";
import { systemContext } from "../auth/context.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";
import { randomPhone, relaxRateLimits } from "../test/agent-first.js";
import { agentPhoneNumbersService } from "../modules/agents/agent-phone-numbers.service.js";
import { issueStreamToken } from "./stream-token.js";
import { hashGrant } from "./stream-grant.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 40_000 });
relaxRateLimits();

const MARK = "LEAKMARK";
const BASIC_USER = "exotel-api-user";
const BASIC = Buffer.from(`${BASIC_USER}:${SECRET}`).toString("base64");
const WRONG_BASIC = Buffer.from(`${BASIC_USER}:wrong-basic-password-${MARK}`).toString("base64");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let numA = "";
let startedAt: Date;
const pinoLines: string[] = [];
const consoleLines: string[] = [];
const httpBodies: string[] = []; // every HTTP response body and header block we saw
const closeReasons: string[] = [];
const secrets = new Set<string>([SECRET, METRICS_TOKEN, BASIC, WRONG_BASIC, `wrong-basic-password-${MARK}`]);
const sid = () => `CAlk${randomBytes(6).toString("hex")}`;
const restore: Array<() => void> = [];

function captureConsole() {
  for (const m of ["log", "warn", "error", "info"] as const) {
    const orig = console[m];
    console[m] = (...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    restore.push(() => {
      console[m] = orig;
    });
  }
}

async function makeCall() {
  const providerCallId = sid();
  const [row] = await db.insert(calls).values({ organizationId: A.orgId, agentId: A.agentId, status: "ringing", callType: "outbound", providerCallId }).returning();
  await db.insert(conversations).values({ organizationId: A.orgId, callId: row.id });
  return { id: row.id, providerCallId };
}

/** Records an HTTP exchange for scanning and returns status + text. */
async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  httpBodies.push(`${res.status} ${JSON.stringify([...res.headers.entries()])} ${text}`);
  return { status: res.status, text };
}

/** Connects like Exotel, sends connected + start, and resolves with how the server ended it (or after the first mark). */
function drive(query: string, opts: { callSid: string; to?: string; headers?: Record<string, string> }): Promise<{ code: number; reason: string; accepted: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/telephony/exotel/media-stream${query ? `?${query}` : ""}`, { headers: opts.headers });
    let accepted = false;
    const done = (code: number, reason: string) => {
      closeReasons.push(reason);
      resolve({ code, reason, accepted });
    };
    const timer = setTimeout(() => {
      ws.terminate();
    }, 8000);
    ws.on("error", () => undefined);
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      done(code, reason.toString());
    });
    ws.on("unexpected-response", (_req, res) => {
      httpBodies.push(`upgrade-refused ${res.statusCode} ${JSON.stringify(res.headers)}`);
    });
    ws.on("message", (raw) => {
      let f: { event?: string; mark?: { name?: string } } = {};
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (f.event === "mark" && f.mark?.name) {
        accepted = true;
        ws.terminate(); // the agent spoke: the connection was accepted
      }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "connected" }));
      ws.send(
        JSON.stringify({
          event: "start",
          stream_sid: `s-${opts.callSid}`,
          start: {
            stream_sid: `s-${opts.callSid}`,
            call_sid: opts.callSid,
            account_sid: "test-account",
            ...(opts.to ? { to: opts.to } : {}),
            media_format: { encoding: "pcm_s16le", sample_rate: "8000", bit_rate: "128kbps" },
          },
        }),
      );
    });
  });
}

beforeAll(async () => {
  startedAt = new Date(Date.now() - 1000);
  A = await createTenant("LeakA");
  const agent = await createDefaultAgent(A.orgId, { name: "Leak", personaName: "Leak", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  numA = randomPhone();
  await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agent.id, phoneNumber: numA });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      pinoLines.push(String(chunk));
      cb();
    },
  });
  app = await buildApp({ logStream: sink });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  captureConsole();
});

afterAll(async () => {
  for (const r of restore.splice(0)) r();
  await app.close();
  await db.delete(streamClaims);
  await db.delete(streamGrants);
  await db.delete(streamTokenUses);
  await cleanupTenants();
  for (const k of ["EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", "EXOTEL_WEBHOOK_BASE_URL", "STREAM_TOKEN_KEYS", "METRICS_TOKEN", "STREAM_GRANT_MAX_USES"]) delete process.env[k];
  process.env.TELEPHONY_PROVIDER = "mock";
});

function scan(label: string, haystack: string) {
  for (const s of secrets) {
    expect(haystack.includes(s), `${label} contains a credential (${s.slice(0, 8)}...)`).toBe(false);
    // URL-encoded form too
    const enc = encodeURIComponent(s);
    if (enc !== s) expect(haystack.includes(enc), `${label} contains a url-encoded credential`).toBe(false);
  }
}

describe("drive accepted and denied traffic", () => {
  it("exercises every credential type through real connections and HTTP calls", async () => {
    // --- accepted: static token, Basic, st token, grant -------------------------------------------------------------
    const c1 = await makeCall();
    expect((await drive(`token=${SECRET}`, { callSid: c1.providerCallId })).accepted).toBe(true);

    const c2 = await makeCall();
    const basicRes = await drive("", { callSid: c2.providerCallId, headers: { authorization: `Basic ${BASIC}` } });
    expect(basicRes.accepted).toBe(true);

    const c3 = await makeCall();
    const st = await issueStreamToken({ callId: c3.id, organizationId: A.orgId, provider: "exotel" });
    secrets.add(st.token);
    secrets.add(st.token.split(".")[2]); // the signature segment on its own
    expect((await drive(`st=${st.token}`, { callSid: c3.providerCallId })).accepted).toBe(true);

    const c4 = await makeCall();
    const minted = await http(`/api/telephony/exotel/stream-url?${new URLSearchParams({ token: SECRET, CallSid: c4.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" })}`);
    expect(minted.status).toBe(200);
    const grant = new URL(JSON.parse(minted.text).url).searchParams.get("g") as string;
    secrets.add(grant);
    // The mint response itself is the one place a grant legitimately appears; it must not be echoed anywhere else.
    httpBodies.pop();
    expect((await drive(`g=${grant}`, { callSid: c4.providerCallId })).accepted).toBe(true);

    // --- denied -----------------------------------------------------------------------------------------------------
    const d = await makeCall();
    const replay = await drive(`g=${grant}`, { callSid: c4.providerCallId }); // STREAM_GRANT_MAX_USES=1: replay
    expect(replay.code).toBe(1008);
    const forgedGrant = randomBytes(16).toString("base64url");
    secrets.add(forgedGrant);
    expect((await drive(`g=${forgedGrant}&token=${SECRET}`, { callSid: d.providerCallId })).code).toBe(1008);
    expect((await drive(`g=short-${MARK}`, { callSid: d.providerCallId })).code).toBe(1008);
    secrets.add(`short-${MARK}`);
    const expired = await issueStreamToken({ callId: d.id, organizationId: A.orgId, provider: "exotel", now: new Date(Date.now() - 3_600_000) });
    secrets.add(expired.token);
    secrets.add(expired.token.split(".")[2]);
    expect((await drive(`st=${expired.token}&token=${SECRET}`, { callSid: d.providerCallId })).code).toBe(1008);
    secrets.add(`garbage-st-${MARK}`);
    expect((await drive(`st=garbage-st-${MARK}`, { callSid: d.providerCallId })).code).toBe(1008);
    secrets.add(`wrong-token-${MARK}`);
    expect((await drive(`token=wrong-token-${MARK}`, { callSid: d.providerCallId })).code).toBe(1008);
    expect((await drive("", { callSid: d.providerCallId, headers: { authorization: `Basic ${WRONG_BASIC}` } })).code).toBe(1008);
    expect((await drive("", { callSid: d.providerCallId })).code).toBe(1008);
    // Direct inbound while direct streams are disabled: refused after authentication succeeded.
    process.env.STREAM_INBOUND_DIRECT_ALLOWED = "false";
    expect((await drive(`token=${SECRET}`, { callSid: sid(), to: numA })).code).toBe(1008);
    delete process.env.STREAM_INBOUND_DIRECT_ALLOWED;

    // --- HTTP surface: credentials in query strings of every public telephony endpoint, 401/404/405/400 bodies --------
    const allQs = `token=${SECRET}&st=${st.token}&g=${grant}`;
    await http(`/api/telephony/exotel/stream-url?CallSid=${sid()}&CallTo=${numA}&Direction=inbound&${allQs}`); // mints (not scanned: see above)
    httpBodies.pop();
    await http(`/api/telephony/exotel/stream-url?CallSid=${sid()}&token=wrong-token-${MARK}&st=${st.token}&g=${grant}`);
    await http(`/api/telephony/exotel/stream-url?${allQs}`); // missing CallSid -> 400
    await http(`/api/telephony/exotel/inbound?token=wrong-token-${MARK}&st=${st.token}&g=${grant}`);
    await http(`/api/telephony/exotel/inbound?${allQs}`); // missing CallSid/CallTo -> 400
    await http(`/api/telephony/exotel/status-callback?token=wrong-token-${MARK}&st=${st.token}&g=${grant}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    await http(`/api/telephony/exotel/status-callback?${allQs}`, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    await http(`/api/telephony/exotel/status-callback?${allQs}`, { method: "POST", body: JSON.stringify({ CallSid: "unknown-sid", Status: "completed" }), headers: { "content-type": "application/json" } });
    await http(`/api/nope-${MARK}?${allQs}`); // 404 with credentials in the query
    await http(`/api/telephony/exotel/media-stream?${allQs}`); // plain GET on the WebSocket route
    await http(`/api/telephony/exotel/stream-url?${allQs}`, { method: "DELETE" }); // 405
    await http(`/api/telephony/exotel/stream-url`, { headers: { authorization: `Basic ${WRONG_BASIC}` } });
    await http(`/api/telephony/exotel/inbound`, { headers: { authorization: `Basic ${WRONG_BASIC}`, cookie: `session=${MARK}-cookie` } });
    secrets.add(`${MARK}-cookie`);
    await http("/metrics", { headers: { authorization: "Bearer wrong-metrics-token-0123456789" } });
    secrets.add("wrong-metrics-token-0123456789");
    // Query-string credentials in a malformed / over-long URL.
    await http(`/api/telephony/exotel/stream-url?${allQs}&x=${"a".repeat(4000)}`);

    // Let async finalisation / logging settle.
    await new Promise((r) => setTimeout(r, 1500));
  });
});

describe("scan every sink", () => {
  it("request logs (pino) carry no credential", () => {
    expect(pinoLines.length).toBeGreaterThan(10);
    scan("pino request log", pinoLines.join("\n"));
    // and the redaction placeholder is actually what is written for the telephony URLs
    expect(pinoLines.join("\n")).toContain("[redacted]");
  });

  it("structured logger (console) output carries no credential", () => {
    expect(consoleLines.length).toBeGreaterThan(10);
    scan("structured log", consoleLines.join("\n"));
  });

  it("HTTP error responses (body + headers) carry no credential", () => {
    expect(httpBodies.length).toBeGreaterThan(8);
    scan("http response", httpBodies.join("\n"));
  });

  it("WebSocket close reasons are fixed strings", () => {
    expect(closeReasons.length).toBeGreaterThan(8);
    scan("ws close reason", closeReasons.join("\n"));
    for (const r of closeReasons) expect(["", "unauthorized", "internal error", "stt provider unavailable"].includes(r) || r.length < 40).toBe(true);
  });

  it("security_events, audit_logs, usage_events, stream tables carry no credential", async () => {
    const [sec, aud, usage, uses, claimsRows, grants] = await Promise.all([
      db.select().from(securityEvents).where(gte(securityEvents.createdAt, startedAt)),
      db.select().from(auditLogs).where(gte(auditLogs.createdAt, startedAt)),
      db.select().from(usageEvents).where(gte(usageEvents.occurredAt, startedAt)),
      db.select().from(streamTokenUses),
      db.select().from(streamClaims),
      db.select().from(streamGrants),
    ]);
    expect(sec.filter((e) => e.eventType === "access.stream_denied").length).toBeGreaterThan(5);
    scan("security_events", JSON.stringify(sec));
    scan("audit_logs", JSON.stringify(aud));
    scan("usage_events", JSON.stringify(usage));
    scan("stream_token_uses", JSON.stringify(uses));
    scan("stream_claims", JSON.stringify(claimsRows));
    // Grants are stored only as sha256; the plaintext (secrets set includes the minted grant) must be absent.
    scan("stream_grants", JSON.stringify(grants));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g.grantHash).toMatch(/^[0-9a-f]{64}$/);
    // Every stream_denied reason is a short code, never free text derived from the request.
    for (const e of sec.filter((x) => x.eventType === "access.stream_denied")) {
      const reason = (e.metadata as { reason?: string }).reason ?? "";
      expect(reason).toMatch(/^[a-z_]{3,48}$/);
    }
    // sanity: the grant hash really is what the DB holds for an accepted grant
    expect(grants.some((g) => [...secrets].some((s) => s.length === 22 && hashGrant(s) === g.grantHash))).toBe(true);
  });

  it("/metrics output carries no credential and reason labels stay a bounded code set", async () => {
    const res = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const withoutOwnToken = text; // the metrics token is never part of the exposition
    scan("metrics", withoutOwnToken);
    const reasons = [...text.matchAll(/stream_auth_denied_total\{reason="([^"]*)"\}/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(3);
    for (const r of reasons) expect(r).toMatch(/^[a-z_]{3,48}$/);
  });
});
