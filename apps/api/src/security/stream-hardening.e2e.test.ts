/**
 * Inbound / flow-mode stream authentication on a static shared secret, plus the cross-instance stream claim.
 * Real HTTP app, real WebSocket, real Postgres (restricted role, RLS), mock STT/LLM/TTS. Negative cases assert the
 * call is untouched and nothing was created.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "exotel";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { adminDb as db } from "../db/client.js";
import { calls, conversations, securityEvents, streamClaims } from "../db/schema.js";
import { streamClaimsRepository } from "../db/repositories/security.repository.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { systemContext } from "../auth/context.js";
import { issueStreamToken } from "./stream-token.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";
import { randomPhone, relaxRateLimits, startTestApp } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { agentPhoneNumbersService } from "../modules/agents/agent-phone-numbers.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

const SECRET = "a-long-random-shared-secret-1234";
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let numA = "";
let numB = "";
const phones: PhoneSocket[] = [];
const sid = () => `CAhd${randomBytes(6).toString("hex")}`;

async function makeCall(
  t: TestTenant,
  opts: { status?: "initiating" | "ringing" | "in_progress" | "completed"; callType?: "outbound" | "inbound"; ageMs?: number } = {},
) {
  const providerCallId = sid();
  const [row] = await db
    .insert(calls)
    .values({
      organizationId: t.orgId,
      agentId: t.agentId,
      status: opts.status ?? "ringing",
      callType: opts.callType ?? "outbound",
      providerCallId,
      ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}),
    })
    .returning();
  await db.insert(conversations).values({ organizationId: t.orgId, callId: row.id });
  return { id: row.id, providerCallId };
}
const rowOf = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0];
const claimRow = async (callId: string) => (await db.select().from(streamClaims).where(eq(streamClaims.callId, callId)))[0];
const orgCalls = async (orgId: string) => (await db.select().from(calls).where(eq(calls.organizationId, orgId))).length;
const denials = async (reason: string) =>
  (await db.select().from(securityEvents).where(and(eq(securityEvents.eventType, "access.stream_denied")))).filter(
    (e) => (e.metadata as { reason?: string }).reason === reason,
  );
const webhook = (params: Record<string, string>) =>
  fetch(`${baseUrl}/api/telephony/exotel/inbound?${new URLSearchParams({ token: SECRET, ...params })}`);
const open = async (o: Parameters<typeof openPhone>[1]) => {
  const p = await openPhone(baseUrl, { token: SECRET, ...o });
  phones.push(p);
  return p;
};
async function expectRefused(o: Parameters<typeof openPhone>[1]) {
  const p = await open(o);
  expect((await p.closed).code).toBe(1008);
  expect(p.marks).toHaveLength(0);
}
async function until(cond: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

beforeAll(async () => {
  A = await createTenant("HrdA");
  B = await createTenant("HrdB");
  const gen = (orgId: string, name: string) =>
    createDefaultAgent(orgId, { name, personaName: name, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
  const agentA = (await gen(A.orgId, "Asha")).id;
  const agentB = (await gen(B.orgId, "Bina")).id;
  numA = randomPhone();
  numB = randomPhone();
  await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agentA, phoneNumber: numA });
  await agentPhoneNumbersService.add(systemContext(B.orgId, "test"), { agentId: agentB, phoneNumber: numB });
  ({ app, baseUrl } = await startTestApp());
});

beforeEach(() => {
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
  process.env.STREAM_ALLOW_STATIC_SECRET = "true";
  process.env.TELEPHONY_PROVIDER = "exotel";
  process.env.STREAM_TOKEN_KEYS = `k1:${randomBytes(32).toString("base64")}`;
});

afterEach(async () => {
  for (const p of phones.splice(0)) {
    try {
      p.ws.terminate();
    } catch {
      // already closed
    }
  }
  for (const k of [
    "EXOTEL_AGENTSTREAM_WEBHOOK_SECRET",
    "STREAM_ALLOW_STATIC_SECRET",
    "STREAM_INBOUND_DIRECT_ALLOWED",
    "STREAM_ALLOWED_ACCOUNT_SIDS",
    "EXOTEL_ACCOUNT_SID",
    "STREAM_FLOW_MAX_AGE_MS",
    "STREAM_INBOUND_MAX_AGE_MS",
    "STREAM_TOKEN_KEYS",
    "STREAM_CLAIM_HEARTBEAT_MS",
    "STREAM_STATIC_REQUIRE_PENDING_STATUS",
  ])
    delete process.env[k];
  process.env.TELEPHONY_PROVIDER = "mock";
});

afterAll(async () => {
  await app.close();
  await db.delete(streamClaims);
  await cleanupTenants();
});

describe("inbound: the webhook registers the call, the stream must match it", () => {
  it("with direct streams disabled, an unknown call_sid creates nothing and is refused", async () => {
    process.env.STREAM_INBOUND_DIRECT_ALLOWED = "false";
    const before = await orgCalls(A.orgId);
    await expectRefused({ callSid: sid(), to: numA, from: randomPhone() });
    expect(await orgCalls(A.orgId)).toBe(before);
    expect((await denials("unregistered_call_sid")).length).toBeGreaterThan(0);
  });

  it("with direct streams disabled, a call announced by the webhook for that exact call_sid attaches", async () => {
    process.env.STREAM_INBOUND_DIRECT_ALLOWED = "false";
    const callSid = sid();
    const res = await webhook({ CallSid: callSid, CallTo: numA, CallFrom: randomPhone() });
    expect(res.status).toBe(200);
    const { callId } = (await res.json()) as { callId: string };
    const p = await open({ callSid, to: numA });
    await p.waitForMarks(1);
    expect((await rowOf(callId)).status).toBe("in_progress");
    expect((await claimRow(callId))?.instanceId).toBe(lifecycle.instanceId);
  });

  it("by default (back-compat) an unannounced call_sid on a dialed number still creates and attaches an inbound call", async () => {
    const before = await orgCalls(A.orgId);
    const p = await open({ callSid: sid(), to: numA, from: randomPhone() });
    await p.waitForMarks(1);
    expect(await orgCalls(A.orgId)).toBe(before + 1);
  });

  it("a retried webhook yields one call and one stream", async () => {
    const callSid = sid();
    const params = { CallSid: callSid, CallTo: numA, CallFrom: randomPhone() };
    const r1 = (await (await webhook(params)).json()) as { callId: string };
    const r2 = (await (await webhook(params)).json()) as { callId: string };
    expect(r2.callId).toBe(r1.callId);
    const p = await open({ callSid, to: numA });
    await p.waitForMarks(1);
    const second = await open({ callSid, to: numA });
    expect((await second.closed).code).toBe(1008);
    expect(p.isOpen()).toBe(true);
  });

  it("cross-tenant: the stream's claimed dialed number never moves a call to another tenant", async () => {
    process.env.STREAM_INBOUND_DIRECT_ALLOWED = "false";
    const callSid = sid();
    const { callId } = (await (await webhook({ CallSid: callSid, CallTo: numB, CallFrom: randomPhone() })).json()) as { callId: string };
    const beforeA = await orgCalls(A.orgId);
    const p = await open({ callSid, to: numA }); // start event claims A's number; the record (B's) decides
    await p.waitForMarks(1);
    const row = await rowOf(callId);
    expect(row.organizationId).toBe(B.orgId);
    expect(row.status).toBe("in_progress");
    expect(await orgCalls(A.orgId)).toBe(beforeA);
  });

  it("a wrong shared secret is refused and the registered call is untouched", async () => {
    const callSid = sid();
    const { callId } = (await (await webhook({ CallSid: callSid, CallTo: numA, CallFrom: randomPhone() })).json()) as { callId: string };
    await expectRefused({ callSid, to: numA, token: "not-the-secret" });
    expect((await rowOf(callId)).status).toBe("ringing");
    expect(await claimRow(callId)).toBeUndefined();
  });

  it("a registration older than STREAM_INBOUND_MAX_AGE_MS cannot be revived", async () => {
    process.env.STREAM_INBOUND_MAX_AGE_MS = "60000";
    const call = await makeCall(A, { callType: "inbound", ageMs: 5 * 60_000 });
    await expectRefused({ callSid: call.providerCallId });
    expect((await rowOf(call.id)).status).toBe("ringing");
    expect((await denials("registration_expired")).length).toBeGreaterThan(0);
  });
});

describe("flow mode (outbound, static secret)", () => {
  it("attaches to a fresh initiating/ringing call", async () => {
    const call = await makeCall(B, { status: "initiating" });
    const p = await open({ callSid: call.providerCallId });
    await p.waitForMarks(1);
    expect((await rowOf(call.id)).organizationId).toBe(B.orgId);
  });

  it("refuses a call older than STREAM_FLOW_MAX_AGE_MS", async () => {
    process.env.STREAM_FLOW_MAX_AGE_MS = "60000";
    const call = await makeCall(A, { ageMs: 10 * 60_000 });
    await expectRefused({ callSid: call.providerCallId });
    expect((await rowOf(call.id)).status).toBe("ringing");
  });

  it("refuses a finished call, and (strict status mode) one that is already in progress", async () => {
    process.env.STREAM_STATIC_REQUIRE_PENDING_STATUS = "true";
    const live = await makeCall(A, { status: "in_progress" });
    await expectRefused({ callSid: live.providerCallId });
    expect((await denials("call_not_awaiting_stream")).length).toBeGreaterThan(0);
    const done = await makeCall(A, { status: "completed" });
    await expectRefused({ callSid: done.providerCallId });
    expect((await rowOf(done.id)).status).toBe("completed");
  });
});

describe("account_sid allow-list", () => {
  it("refuses a stream from another Exotel account and accepts the configured one", async () => {
    process.env.EXOTEL_ACCOUNT_SID = "acme_main";
    process.env.STREAM_ALLOWED_ACCOUNT_SIDS = "acme_sub";
    const bad = await makeCall(A);
    await expectRefused({ callSid: bad.providerCallId, accountSid: "evil_account" });
    expect((await rowOf(bad.id)).status).toBe("ringing");
    expect((await denials("account_sid_not_allowed")).length).toBeGreaterThan(0);

    const ok = await makeCall(A);
    const p = await open({ callSid: ok.providerCallId, accountSid: "acme_main" });
    await p.waitForMarks(1);
    expect((await rowOf(ok.id)).status).toBe("in_progress");
  });

  it("also applies to a valid per-call token", async () => {
    process.env.STREAM_ALLOWED_ACCOUNT_SIDS = "acme_sub";
    const call = await makeCall(A);
    const { token } = await issueStreamToken({ callId: call.id, organizationId: A.orgId, provider: "exotel" });
    const p = await openPhone(baseUrl, { callSid: call.providerCallId, streamToken: token, accountSid: "evil_account" });
    phones.push(p);
    expect((await p.closed).code).toBe(1008);
    expect((await rowOf(call.id)).status).toBe("ringing");
  });
});

describe("expired credentials", () => {
  it("an expired token is refused even when the shared secret is also correct", async () => {
    const call = await makeCall(A);
    const { token } = await issueStreamToken({ callId: call.id, organizationId: A.orgId, provider: "exotel", now: new Date(Date.now() - 3 * 3600_000) });
    await expectRefused({ callSid: call.providerCallId, streamToken: token });
    expect((await rowOf(call.id)).status).toBe("ringing");
  });
});

describe("shared claim across instances", () => {
  it("concurrent duplicate streams: exactly one attaches and one claim row exists", async () => {
    const call = await makeCall(A);
    const attempts = await Promise.all(Array.from({ length: 4 }, () => open({ callSid: call.providerCallId })));
    await new Promise((r) => setTimeout(r, 2000));
    expect(attempts.filter((p) => p.isOpen()).length).toBe(1);
    expect((await claimRow(call.id))?.instanceId).toBe(lifecycle.instanceId);
  });

  it("the repository claim is atomic: of many simultaneous claimers one wins; only the holder heartbeats or releases", async () => {
    const callId = (await makeCall(A)).id;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => streamClaimsRepository.claim({ callId, instanceId: `inst-${i}`, staleMs: 30_000 })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = (await claimRow(callId)).instanceId;
    expect(await streamClaimsRepository.heartbeat({ callId, instanceId: "someone-else" })).toBe(false);
    expect(await streamClaimsRepository.heartbeat({ callId, instanceId: winner })).toBe(true);
    await streamClaimsRepository.release({ callId, instanceId: "someone-else" });
    expect(await claimRow(callId)).toBeDefined();
    await streamClaimsRepository.release({ callId, instanceId: winner });
    expect(await claimRow(callId)).toBeUndefined();
  });

  it("a live claim held by another instance refuses the stream; a stale one is taken over", async () => {
    const call = await makeCall(A);
    await db.insert(streamClaims).values({ callId: call.id, instanceId: "other-instance" });
    await expectRefused({ callSid: call.providerCallId });
    expect((await claimRow(call.id)).instanceId).toBe("other-instance");
    expect((await rowOf(call.id)).status).toBe("ringing");

    await db.update(streamClaims).set({ heartbeatAt: new Date(Date.now() - 5 * 60_000) }).where(eq(streamClaims.callId, call.id));
    const p = await open({ callSid: call.providerCallId });
    await p.waitForMarks(1);
    expect((await claimRow(call.id)).instanceId).toBe(lifecycle.instanceId);
  });

  it("releases the claim when the socket drops, and the dropped call cannot be re-attached", async () => {
    const call = await makeCall(A);
    const first = await open({ callSid: call.providerCallId });
    await first.waitForMarks(1);
    expect(await claimRow(call.id)).toBeDefined();
    first.ws.terminate();
    await first.closed;
    expect(await until(async () => (await claimRow(call.id)) === undefined)).toBe(true);
    expect(await until(async () => (await rowOf(call.id)).status === "completed")).toBe(true);
    const again = await open({ callSid: call.providerCallId });
    expect((await again.closed).code).toBe(1008);
  });

  it("the heartbeat keeps a long stream's claim fresh", async () => {
    process.env.STREAM_CLAIM_HEARTBEAT_MS = "300";
    const call = await makeCall(A);
    const p = await open({ callSid: call.providerCallId });
    await p.waitForMarks(1);
    const t0 = (await claimRow(call.id)).heartbeatAt.getTime();
    expect(await until(async () => (await claimRow(call.id)).heartbeatAt.getTime() > t0, 5000)).toBe(true);
  });
});
