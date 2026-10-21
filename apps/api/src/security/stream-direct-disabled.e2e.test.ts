/**
 * STREAM_INBOUND_DIRECT_ALLOWED=false: which flows keep working and which are refused (and why).
 * Companion to docs/security/stream-direct-dependencies.md. Real HTTP app, real WebSocket, real Postgres; mock
 * providers; no real Exotel. This proves OUR side only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "exotel";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";
process.env.WEB_CALL_ENABLED = "true";

import { adminDb as db } from "../db/client.js";
import { calls, conversations, securityEvents, streamClaims, streamGrants, streamTokenUses } from "../db/schema.js";
import { systemContext } from "../auth/context.js";
import { cleanupTenants, createDefaultAgent, createTenant, loginCookie, type TestTenant } from "../test/tenants.js";
import { randomPhone, relaxRateLimits, startTestApp } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { agentPhoneNumbersService } from "../modules/agents/agent-phone-numbers.service.js";
import { issueStreamToken } from "./stream-token.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 40_000 });
relaxRateLimits();

const SECRET = "a-long-random-shared-secret-1234";
const KEY = randomBytes(32).toString("base64");
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let numA = "";
const phones: PhoneSocket[] = [];
const sid = () => `CAdd${randomBytes(6).toString("hex")}`;

async function makeCall(opts: { status?: "initiating" | "ringing"; linked?: boolean; callType?: "outbound" | "test" } = {}) {
  const providerCallId = sid();
  const [row] = await db
    .insert(calls)
    .values({
      organizationId: A.orgId,
      agentId: A.agentId,
      status: opts.status ?? "ringing",
      callType: opts.callType ?? "outbound",
      providerCallId: opts.linked === false ? null : providerCallId,
    })
    .returning();
  await db.insert(conversations).values({ organizationId: A.orgId, callId: row.id });
  return { id: row.id, providerCallId };
}
const rowOf = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0];
const bySid = async (providerCallId: string) => (await db.select().from(calls).where(eq(calls.providerCallId, providerCallId)))[0];
const denials = async (reason: string) =>
  (await db.select().from(securityEvents).where(and(eq(securityEvents.eventType, "access.stream_denied")))).filter(
    (e) => (e.metadata as { reason?: string }).reason === reason,
  );
const open = async (o: Parameters<typeof openPhone>[1]) => {
  const p = await openPhone(baseUrl, o);
  phones.push(p);
  return p;
};

beforeAll(async () => {
  A = await createTenant("DirA");
  const agent = await createDefaultAgent(A.orgId, { name: "Dir", personaName: "Dir", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  numA = randomPhone();
  await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agent.id, phoneNumber: numA });
  ({ app, baseUrl } = await startTestApp());
});

beforeEach(() => {
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEPHONY_PROVIDER = "exotel";
  process.env.EXOTEL_WEBHOOK_BASE_URL = "https://voice-api.example-company.in";
  process.env.STREAM_TOKEN_KEYS = `k1:${KEY}`;
  process.env.STREAM_INBOUND_DIRECT_ALLOWED = "false";
});

afterEach(() => {
  for (const p of phones.splice(0)) {
    try {
      p.ws.terminate();
    } catch {
      // already closed
    }
  }
  for (const k of ["EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", "EXOTEL_WEBHOOK_BASE_URL", "STREAM_TOKEN_KEYS", "STREAM_INBOUND_DIRECT_ALLOWED", "STREAM_REQUIRE_GRANT"]) delete process.env[k];
  process.env.TELEPHONY_PROVIDER = "mock";
});

afterAll(async () => {
  await app.close();
  await db.delete(streamClaims);
  await db.delete(streamGrants);
  await db.delete(streamTokenUses);
  await cleanupTenants();
});

describe("STREAM_INBOUND_DIRECT_ALLOWED=false: flows that must keep working", () => {
  it("inbound: webhook registers the call, then the static-secret stream attaches to that exact call_sid", async () => {
    const callSid = sid();
    const res = await fetch(
      `${baseUrl}/api/telephony/exotel/inbound?${new URLSearchParams({ token: SECRET, CallSid: callSid, CallTo: numA, CallFrom: randomPhone() })}`,
    );
    expect(res.status).toBe(200);
    const row = await bySid(callSid);
    expect(row.organizationId).toBe(A.orgId);
    const p = await open({ callSid, to: numA, token: SECRET });
    await p.waitForMarks(1);
    expect((await rowOf(row.id)).status).toBe("in_progress");
  });

  it("outbound API (StreamUrl mode): the per-call st token attaches, even before the provider id is linked", async () => {
    process.env.STREAM_ALLOW_STATIC_SECRET = "false";
    try {
      const c = await makeCall({ linked: false, status: "initiating" });
      const { token } = await issueStreamToken({ callId: c.id, organizationId: A.orgId, provider: "exotel" });
      const p = await open({ callSid: sid(), streamToken: token });
      await p.waitForMarks(1);
      expect((await rowOf(c.id)).status).toBe("in_progress");
    } finally {
      delete process.env.STREAM_ALLOW_STATIC_SECRET;
    }
  });

  it("outbound flow mode: a static-secret stream attaches to the existing call row found by call_sid", async () => {
    const c = await makeCall();
    const p = await open({ callSid: c.providerCallId, token: SECRET });
    await p.waitForMarks(1);
    expect((await rowOf(c.id)).status).toBe("in_progress");
  });

  it("outbound flow mode, link race: the stream waits for the call_sid link instead of being refused", async () => {
    const c = await makeCall({ linked: false, status: "initiating" });
    const callSid = sid();
    const p = await open({ callSid, token: SECRET });
    setTimeout(() => {
      void (async () => {
        await db.update(calls).set({ providerCallId: callSid }).where(eq(calls.id, c.id));
      })();
    }, 700);
    await p.waitForMarks(1);
    expect((await rowOf(c.id)).status).toBe("in_progress");
  });

  it("grant path: the dynamic endpoint registers an inbound call and the grant alone attaches (no secret on the stream)", async () => {
    const callSid = sid();
    const res = await fetch(
      `${baseUrl}/api/telephony/exotel/stream-url?${new URLSearchParams({ token: SECRET, CallSid: callSid, CallTo: numA, CallFrom: randomPhone(), Direction: "inbound" })}`,
    );
    expect(res.status).toBe(200);
    const grant = new URL(((await res.json()) as { url: string }).url).searchParams.get("g") as string;
    const p = await open({ callSid, grant });
    await p.waitForMarks(1);
    expect((await bySid(callSid)).status).toBe("in_progress");
  });

  it("STREAM_REQUIRE_GRANT=true together with direct=false: grant streams work, static-only streams are refused as grant_required", async () => {
    process.env.STREAM_REQUIRE_GRANT = "true";
    const c = await makeCall();
    const refused = await open({ callSid: c.providerCallId, token: SECRET });
    expect((await refused.closed).code).toBe(1008);
    const res = await fetch(
      `${baseUrl}/api/telephony/exotel/stream-url?${new URLSearchParams({ token: SECRET, CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" })}`,
    );
    const grant = new URL(((await res.json()) as { url: string }).url).searchParams.get("g") as string;
    const ok = await open({ callSid: c.providerCallId, grant });
    await ok.waitForMarks(1);
    expect((await rowOf(c.id)).status).toBe("in_progress");
  });

  it("local simulator / mock provider: explicit internalCallId, no secret configured, still attaches", async () => {
    process.env.TELEPHONY_PROVIDER = "mock";
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
    const c = await makeCall({ callType: "test" });
    const p = await open({ callSid: c.providerCallId, internalCallId: c.id });
    await p.waitForMarks(1);
    expect((await rowOf(c.id)).status).toBe("in_progress");
  });

  it("browser web call: session-authenticated, bound to the user's own call, unaffected by the flag", async () => {
    const cookie = await loginCookie(baseUrl, A.email);
    const created = await fetch(`${baseUrl}/api/calls/web`, { method: "POST", headers: { cookie } });
    expect(created.status).toBe(201);
    const callId = ((await created.json()) as { data: { callId: string } }).data.callId;
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/web-call/stream?callId=${callId}`, {
      headers: { cookie, origin: "http://127.0.0.1:3000" },
    });
    let marks = 0;
    ws.on("error", () => undefined);
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { event?: string; mark?: { name?: string } };
      if (f.event === "mark" && f.mark?.name) {
        marks++;
        ws.send(JSON.stringify({ event: "mark", stream_sid: "web-1", mark: { name: f.mark.name } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(
      JSON.stringify({
        event: "start",
        stream_sid: "web-1",
        start: { stream_sid: "web-1", call_sid: `web-${callId}`, media_format: { encoding: "pcm_s16le", sample_rate: "8000", bit_rate: "128kbps" } },
      }),
    );
    const until = Date.now() + 10_000;
    while (marks < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    ws.terminate();
    expect(marks).toBeGreaterThan(0);
  });
});

describe("STREAM_INBOUND_DIRECT_ALLOWED=false: direct-dependent flows are refused (unregistered_call_sid)", () => {
  it("direct inbound stream (no webhook, no grant): refused 1008, creates no call, records the documented reason", async () => {
    const callSid = sid();
    const before = (await denials("unregistered_call_sid")).length;
    const p = await open({ callSid, to: numA, token: SECRET });
    expect((await p.closed).code).toBe(1008);
    expect(p.marks).toHaveLength(0);
    expect(await bySid(callSid)).toBeUndefined();
    expect((await denials("unregistered_call_sid")).length).toBe(before + 1);
  });

  it("exotel:preflight step 4 shape (synthetic call_sid, mapped ExoPhone, static secret): refused, so the preflight reports FAIL", async () => {
    const callSid = `preflight-${Date.now()}`;
    const p = await open({ callSid, to: numA, from: randomPhone(), token: SECRET });
    expect((await p.closed).code).toBe(1008);
    expect(await bySid(callSid)).toBeUndefined();
  });

  it("static Voicebot applet URL on an inbound number with no inbound webhook applet: refused, nothing created", async () => {
    const callSid = sid();
    const p = await open({ callSid, to: numA, from: randomPhone(), token: SECRET, accountSid: "AC-any" });
    expect((await p.closed).code).toBe(1008);
    expect(await bySid(callSid)).toBeUndefined();
  });

  it("a stream with no call_sid and no internalCallId is closed without audio (init failure, not a 1008 security refusal)", async () => {
    const p = await open({ callSid: "", to: numA, token: SECRET });
    await p.closed;
    expect(p.marks).toHaveLength(0);
  });
});

describe("contrast: the documented default (direct=true) is what makes those flows work", () => {
  it("with STREAM_INBOUND_DIRECT_ALLOWED=true a direct inbound stream creates the call and attaches", async () => {
    process.env.STREAM_INBOUND_DIRECT_ALLOWED = "true";
    const callSid = sid();
    const p = await open({ callSid, to: numA, from: randomPhone(), token: SECRET });
    await p.waitForMarks(1);
    const row = await bySid(callSid);
    expect(row.organizationId).toBe(A.orgId);
    expect(row.callType).toBe("inbound");
  });
});
