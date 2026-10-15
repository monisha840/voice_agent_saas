/**
 * The media-stream WebSocket as Exotel uses it, with per-call tokens: real HTTP app, real WebSocket, real Postgres
 * (restricted role, RLS), mock STT/LLM/TTS. Negative cases assert the call is untouched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { adminDb as db } from "../db/client.js";
import { calls, conversations, securityEvents, streamTokenUses } from "../db/schema.js";
import { issueStreamToken } from "./stream-token.js";
import { cleanupTenants, createTenant, type TestTenant } from "../test/tenants.js";
import { relaxRateLimits, startTestApp, waitForSummary } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

const KEY = randomBytes(32).toString("base64");
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
const phones: PhoneSocket[] = [];
const sid = () => `CAst${randomBytes(6).toString("hex")}`;

async function makeCall(t: TestTenant, status: "initiating" | "ringing" | "in_progress" | "completed" = "ringing") {
  const providerCallId = sid();
  const [row] = await db
    .insert(calls)
    .values({ organizationId: t.orgId, agentId: t.agentId, status, callType: "test", providerCallId })
    .returning();
  await db.insert(conversations).values({ organizationId: t.orgId, callId: row.id });
  return { id: row.id, providerCallId, organizationId: t.orgId };
}
const rowOf = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0];
const tokenFor = (c: { id: string }, orgId: string) => issueStreamToken({ callId: c.id, organizationId: orgId, provider: "exotel" });
const denials = async (reason: string) =>
  (await db.select().from(securityEvents).where(and(eq(securityEvents.eventType, "access.stream_denied")))).filter(
    (e) => (e.metadata as { reason?: string }).reason === reason,
  );

async function expectRefused(opts: Parameters<typeof openPhone>[1]) {
  const phone = await openPhone(baseUrl, opts);
  phones.push(phone);
  const closed = await phone.closed;
  expect(closed.code).toBe(1008);
  expect(phone.marks).toHaveLength(0); // the agent never spoke
}

beforeAll(async () => {
  process.env.STREAM_TOKEN_KEYS = `k1:${KEY}`;
  A = await createTenant("StrA");
  B = await createTenant("StrB");
  ({ app, baseUrl } = await startTestApp());
});

beforeEach(() => {
  process.env.STREAM_TOKEN_KEYS = `k1:${KEY}`;
  process.env.STREAM_ALLOW_STATIC_SECRET = "false"; // token mandatory unless a test says otherwise
  delete process.env.STREAM_TOKEN_MAX_USES;
});

afterEach(async () => {
  for (const p of phones.splice(0)) {
    try {
      p.ws.terminate();
    } catch {
      // already closed
    }
  }
  delete process.env.STREAM_ALLOW_STATIC_SECRET;
});

afterAll(async () => {
  await app.close();
  await db.delete(streamTokenUses);
  await cleanupTenants();
  delete process.env.STREAM_TOKEN_KEYS;
});

describe("a valid per-call token", () => {
  it("opens the stream, answers the call and runs the conversation to completion", async () => {
    const call = await makeCall(A);
    const { token } = await tokenFor(call, A.orgId);
    const phone = await openPhone(baseUrl, { callSid: call.providerCallId, streamToken: token });
    phones.push(phone);
    await phone.waitForMarks(1);
    expect((await rowOf(call.id)).status).toBe("in_progress");
    await phone.hangUp();
    await waitForSummary(A.orgId, call.id);
    expect((await rowOf(call.id)).status).toBe("completed");
  });

  it("binds to the token's call even when the peer's start event names no known call_sid", async () => {
    const call = await makeCall(A, "initiating"); // provider id not linked yet (the outbound race)
    await db.update(calls).set({ providerCallId: null }).where(eq(calls.id, call.id));
    const { token } = await tokenFor(call, A.orgId);
    const phone = await openPhone(baseUrl, { callSid: `CAunlinked${randomBytes(4).toString("hex")}`, streamToken: token });
    phones.push(phone);
    await phone.waitForMarks(1);
    expect((await rowOf(call.id)).organizationId).toBe(A.orgId);
    await phone.hangUp();
  });
});

describe("rejected tokens: the stream is closed (1008) before any audio and the call is untouched", () => {
  it("no token while tokens are mandatory", async () => {
    const call = await makeCall(A);
    await expectRefused({ callSid: call.providerCallId });
    expect((await rowOf(call.id)).status).toBe("ringing");
    expect((await denials("token_required")).length).toBeGreaterThan(0);
  });

  it("malformed token", async () => {
    const call = await makeCall(A);
    await expectRefused({ callSid: call.providerCallId, streamToken: "this-is-not-a-token" });
    expect((await rowOf(call.id)).status).toBe("ringing");
  });

  it("token signed with another key", async () => {
    const call = await makeCall(A);
    const forged = await new SignJWT({ org: A.orgId, prv: "exotel", typ2: "media-stream" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("voice-engine").setAudience("voice-engine:media-stream").setSubject(call.id).setJti(randomUUID())
      .setIssuedAt().setExpirationTime("10m")
      .sign(new Uint8Array(randomBytes(32)));
    await expectRefused({ callSid: call.providerCallId, streamToken: forged });
    expect((await rowOf(call.id)).status).toBe("ringing");
    expect((await denials("token_bad_signature")).length).toBeGreaterThan(0);
  });

  it("expired token", async () => {
    const call = await makeCall(A);
    const { token } = await issueStreamToken({ callId: call.id, organizationId: A.orgId, provider: "exotel", now: new Date(Date.now() - 3 * 3600_000) });
    await expectRefused({ callSid: call.providerCallId, streamToken: token });
    expect((await rowOf(call.id)).status).toBe("ringing");
    expect((await denials("token_expired")).length).toBeGreaterThan(0);
  });

  it("call-id substitution: A's token with a start event naming B's call", async () => {
    const callA = await makeCall(A);
    const callB = await makeCall(B);
    const { token } = await tokenFor(callA, A.orgId);
    await expectRefused({ callSid: callB.providerCallId, streamToken: token });
    expect((await rowOf(callB.id)).status).toBe("ringing"); // B's call never touched
    expect((await rowOf(callA.id)).status).toBe("ringing");
  });

  it("tenant substitution: a token naming B's organization for A's call", async () => {
    const callA = await makeCall(A);
    const { token } = await tokenFor(callA, B.orgId);
    await expectRefused({ callSid: callA.providerCallId, streamToken: token });
    expect((await rowOf(callA.id)).status).toBe("ringing");
    expect((await denials("token_call_mismatch")).length).toBeGreaterThan(0);
  });

  it("a finished call cannot be re-attached, even with a valid token", async () => {
    const call = await makeCall(A, "completed");
    const { token } = await tokenFor(call, A.orgId);
    await expectRefused({ callSid: call.providerCallId, streamToken: token });
    expect((await rowOf(call.id)).status).toBe("completed");
    expect((await denials("call_not_live")).length).toBeGreaterThan(0);
  });

  it("a bad token is NOT rescued by a correct shared secret", async () => {
    process.env.STREAM_ALLOW_STATIC_SECRET = "true";
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "a-long-random-shared-secret-1234";
    try {
      const call = await makeCall(A);
      await expectRefused({ callSid: call.providerCallId, streamToken: "bad.token.value", token: "a-long-random-shared-secret-1234" });
      expect((await rowOf(call.id)).status).toBe("ringing");
    } finally {
      process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
    }
  });
});

describe("replay and concurrency", () => {
  it("a token may open only a bounded number of connections (counted in the database)", async () => {
    process.env.STREAM_TOKEN_MAX_USES = "2";
    const call = await makeCall(A);
    const { token, jti } = await tokenFor(call, A.orgId);
    const first = await openPhone(baseUrl, { callSid: call.providerCallId, streamToken: token });
    phones.push(first);
    await first.waitForMarks(1);
    first.ws.terminate();
    await first.closed;
    // The call was ended by that drop; use fresh calls to exercise the counter itself with the same token id.
    const [row] = await db.select().from(streamTokenUses).where(eq(streamTokenUses.jti, jti));
    expect(row.uses).toBe(1);

    const call2 = await makeCall(A);
    const t2 = await tokenFor(call2, A.orgId);
    for (let i = 0; i < 2; i++) {
      const p = await openPhone(baseUrl, { callSid: call2.providerCallId, streamToken: t2.token });
      phones.push(p);
      await p.waitForMarks(1).catch(() => undefined);
      p.ws.terminate();
      await p.closed;
      // let the server settle the ended call before the next attempt reuses the token on a fresh live call
      await db.update(calls).set({ status: "ringing", endedAt: null }).where(eq(calls.id, call2.id));
    }
    const replay = await openPhone(baseUrl, { callSid: call2.providerCallId, streamToken: t2.token });
    phones.push(replay);
    expect((await replay.closed).code).toBe(1008);
    expect((await denials("token_reused")).length).toBeGreaterThan(0);
  });

  it("a second stream for a call that is already streaming is refused and does not disturb the first", async () => {
    const call = await makeCall(A);
    const t1 = await tokenFor(call, A.orgId);
    const first = await openPhone(baseUrl, { callSid: call.providerCallId, streamToken: t1.token });
    phones.push(first);
    await first.waitForMarks(1);

    const t2 = await tokenFor(call, A.orgId); // a perfectly valid token for the same call
    const second = await openPhone(baseUrl, { callSid: call.providerCallId, streamToken: t2.token });
    phones.push(second);
    expect((await second.closed).code).toBe(1008);
    expect(first.isOpen()).toBe(true); // legitimate stream unaffected
    await first.hangUp();
  });

  it("concurrent attempts with one token for one call: at most one stream attaches", async () => {
    const call = await makeCall(A);
    const { token } = await tokenFor(call, A.orgId);
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => openPhone(baseUrl, { callSid: call.providerCallId, streamToken: token })),
    );
    phones.push(...attempts);
    await new Promise((r) => setTimeout(r, 1500));
    expect(attempts.filter((p) => p.isOpen()).length).toBeLessThanOrEqual(1);
  });
});

describe("the shared secret path (inbound calls and flow mode) stays separate and cannot choose a call", () => {
  it("accepts the shared secret when allowed, and a caller-chosen internalCallId is ignored with a real provider", async () => {
    process.env.STREAM_ALLOW_STATIC_SECRET = "true";
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "a-long-random-shared-secret-1234";
    process.env.TELEPHONY_PROVIDER = "exotel";
    try {
      const callA = await makeCall(A);
      const callB = await makeCall(B);
      // The peer asks for A's call id in the URL but its own start event names B's call: B's call is what attaches.
      const phone = await openPhone(baseUrl, {
        callSid: callB.providerCallId,
        internalCallId: callA.id,
        token: "a-long-random-shared-secret-1234",
      });
      phones.push(phone);
      await phone.waitForMarks(1);
      expect((await rowOf(callB.id)).status).toBe("in_progress");
      expect((await rowOf(callA.id)).status).toBe("ringing"); // the caller-chosen id was not honoured
      await phone.hangUp();
    } finally {
      process.env.TELEPHONY_PROVIDER = "mock";
      process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
    }
  });

  it("is refused outright when static secrets are disabled", async () => {
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "a-long-random-shared-secret-1234";
    try {
      const call = await makeCall(A);
      await expectRefused({ callSid: call.providerCallId, token: "a-long-random-shared-secret-1234" });
      expect((await rowOf(call.id)).status).toBe("ringing");
    } finally {
      process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
    }
  });
});

describe("audit and leakage", () => {
  it("denials are recorded with a reason and never contain a token or secret", async () => {
    const call = await makeCall(A);
    const { token } = await issueStreamToken({ callId: call.id, organizationId: A.orgId, provider: "exotel", now: new Date(Date.now() - 3 * 3600_000) });
    await expectRefused({ callSid: call.providerCallId, streamToken: token });
    const rows = await db.select().from(securityEvents).where(eq(securityEvents.eventType, "access.stream_denied"));
    expect(rows.length).toBeGreaterThan(0);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(KEY);
  });
});
