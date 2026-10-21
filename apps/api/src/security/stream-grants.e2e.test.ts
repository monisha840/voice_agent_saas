/**
 * Opt-in per-call stream grants minted by the Voicebot dynamic endpoint (/api/telephony/exotel/stream-url) and
 * consumed on the media-stream upgrade (?g=). Real HTTP app, real WebSocket, real Postgres; mock providers.
 * UNVERIFIED against real Exotel: these tests prove OUR side of the contract only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "exotel";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { adminDb as db } from "../db/client.js";
import { calls, conversations, streamClaims, streamGrants } from "../db/schema.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { systemContext } from "../auth/context.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../test/tenants.js";
import { randomPhone, relaxRateLimits, startTestApp } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { agentPhoneNumbersService } from "../modules/agents/agent-phone-numbers.service.js";
import { hashGrant } from "./stream-grant.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

const SECRET = "a-long-random-shared-secret-1234";
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let numA = "";
const phones: PhoneSocket[] = [];
const sid = () => `CAgr${randomBytes(6).toString("hex")}`;

async function makeCall(t: TestTenant) {
  const providerCallId = sid();
  const [row] = await db
    .insert(calls)
    .values({ organizationId: t.orgId, agentId: t.agentId, status: "ringing", callType: "outbound", providerCallId })
    .returning();
  await db.insert(conversations).values({ organizationId: t.orgId, callId: row.id });
  return { id: row.id, providerCallId };
}
const rowOf = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0];
const claimRow = async (id: string) => (await db.select().from(streamClaims).where(eq(streamClaims.callId, id)))[0];
const streamUrl = (params: Record<string, string>, token: string | null = SECRET) =>
  fetch(`${baseUrl}/api/telephony/exotel/stream-url?${new URLSearchParams({ ...(token ? { token } : {}), ...params })}`);
async function mint(params: Record<string, string>) {
  const res = await streamUrl(params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string };
  return { body, grant: new URL(body.url).searchParams.get("g") as string };
}
// The shared secret is deliberately NOT sent on grant streams: the grant must be sufficient on its own.
const open = async (o: Parameters<typeof openPhone>[1]) => {
  const p = await openPhone(baseUrl, o);
  phones.push(p);
  return p;
};

beforeAll(async () => {
  A = await createTenant("GrA");
  B = await createTenant("GrB");
  const agentA = (
    await createDefaultAgent(A.orgId, { name: "Asha", personaName: "Asha", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
  ).id;
  numA = randomPhone();
  await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agentA, phoneNumber: numA });
  ({ app, baseUrl } = await startTestApp());
});

beforeEach(() => {
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEPHONY_PROVIDER = "exotel";
  process.env.EXOTEL_WEBHOOK_BASE_URL = "https://voice-api.example-company.in";
});

afterEach(() => {
  for (const p of phones.splice(0)) {
    try {
      p.ws.terminate();
    } catch {
      // already closed
    }
  }
  for (const k of ["EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", "EXOTEL_WEBHOOK_BASE_URL", "STREAM_REQUIRE_GRANT", "STREAM_GRANT_TTL_MS", "STREAM_GRANT_MAX_USES"])
    delete process.env[k];
  process.env.TELEPHONY_PROVIDER = "mock";
});

afterAll(async () => {
  await app.close();
  await db.delete(streamClaims);
  await db.delete(streamGrants);
  await cleanupTenants();
});

describe("stream-url endpoint authentication", () => {
  it("refuses a missing or wrong secret (401) and mints nothing", async () => {
    const before = (await db.select().from(streamGrants)).length;
    expect((await streamUrl({ CallSid: sid(), CallTo: numA, Direction: "inbound" }, null)).status).toBe(401);
    expect((await streamUrl({ CallSid: sid(), CallTo: numA, Direction: "inbound" }, "nope")).status).toBe(401);
    expect((await db.select().from(streamGrants)).length).toBe(before);
  });

  it("accepts Basic auth like the other telephony endpoints", async () => {
    const qs = new URLSearchParams({ CallSid: sid(), CallTo: numA, Direction: "inbound" });
    const res = await fetch(`${baseUrl}/api/telephony/exotel/stream-url?${qs}`, {
      headers: { authorization: `Basic ${Buffer.from(`exotel:${SECRET}`).toString("base64")}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("grants", () => {
  it("inbound: the endpoint registers the call and the grant alone attaches the stream to it", async () => {
    const callSid = sid();
    const { body, grant } = await mint({ CallSid: callSid, CallTo: numA, CallFrom: randomPhone(), Direction: "inbound" });
    expect(body.url.startsWith("wss://voice-api.example-company.in/api/telephony/exotel/media-stream?g=")).toBe(true);
    const [row] = await db.select().from(calls).where(eq(calls.providerCallId, callSid));
    expect(row.organizationId).toBe(A.orgId);
    // The shared secret is never handed out, and the URL fits Exotel's 256-character applet limit.
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.url).not.toMatch(/token=/);
    expect(body.url.length).toBeLessThan(256);
    expect(grant).toHaveLength(22);

    const p = await open({ callSid, to: numA, grant });
    await p.waitForMarks(1);
    expect((await rowOf(row.id)).status).toBe("in_progress");
    expect((await claimRow(row.id))?.instanceId).toBe(lifecycle.instanceId);
  });

  it("outbound flow mode: looks the call up by CallSid and never creates one", async () => {
    const c = await makeCall(A);
    const { grant } = await mint({ CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    const p = await open({ callSid: c.providerCallId, grant });
    await p.waitForMarks(1);
    expect((await claimRow(c.id))?.instanceId).toBe(lifecycle.instanceId);

    const unknown = await streamUrl({ CallSid: sid(), CallTo: randomPhone(), Direction: "outbound-api" });
    expect(unknown.status).toBe(404);
  });

  it("stores only the hash of a grant (database scan)", async () => {
    const { grant } = await mint({ CallSid: sid(), CallTo: numA, Direction: "inbound" });
    const rows = await db.select().from(streamGrants);
    expect(rows.some((r) => r.grantHash === hashGrant(grant))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(grant);
  });

  it("a forged grant is refused and a good shared secret does not rescue it", async () => {
    const c = await makeCall(A);
    const p = await open({ callSid: c.providerCallId, token: SECRET, grant: randomBytes(16).toString("base64url") });
    expect((await p.closed).code).toBe(1008);
    expect(await claimRow(c.id)).toBeUndefined();
    expect((await rowOf(c.id)).status).toBe("ringing");
  });

  it("a grant for one call cannot attach another call's stream (call_sid substitution, cross-tenant)", async () => {
    const mine = await makeCall(A);
    const theirs = await makeCall(B);
    const { grant } = await mint({ CallSid: mine.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    const p = await open({ callSid: theirs.providerCallId, grant });
    expect((await p.closed).code).toBe(1008);
    expect(p.marks).toHaveLength(0);
    expect((await rowOf(theirs.id)).status).toBe("ringing");
    expect(await claimRow(theirs.id)).toBeUndefined();
    expect(await claimRow(mine.id)).toBeUndefined();
  });

  it("an expired grant is refused", async () => {
    const c = await makeCall(A);
    const { grant } = await mint({ CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    await db.update(streamGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(streamGrants.grantHash, hashGrant(grant)));
    const p = await open({ callSid: c.providerCallId, grant });
    expect((await p.closed).code).toBe(1008);
    expect(await claimRow(c.id)).toBeUndefined();
  });

  it("replay beyond STREAM_GRANT_MAX_USES is refused", async () => {
    process.env.STREAM_GRANT_MAX_USES = "1";
    const c = await makeCall(A);
    const { grant } = await mint({ CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    const first = await open({ callSid: c.providerCallId, grant });
    await first.waitForMarks(1);
    first.ws.terminate();
    await first.closed;
    const replay = await open({ callSid: c.providerCallId, grant });
    expect((await replay.closed).code).toBe(1008);
    const [g] = await db.select().from(streamGrants).where(eq(streamGrants.grantHash, hashGrant(grant)));
    expect(g.uses).toBe(1);
  });

  it("concurrent duplicate attach: one stream wins, the other is refused", async () => {
    const c = await makeCall(A);
    const { grant } = await mint({ CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    const [p1, p2] = await Promise.all([open({ callSid: c.providerCallId, grant }), open({ callSid: c.providerCallId, grant })]);
    const first = await Promise.race([p1.closed.then(() => "p1"), p2.closed.then(() => "p2")]);
    const loser = first === "p1" ? p1 : p2;
    const winner = first === "p1" ? p2 : p1;
    expect((await loser.closed).code).toBe(1008);
    await winner.waitForMarks(1);
    expect(winner.isOpen()).toBe(true);
  });

  it("STREAM_REQUIRE_GRANT=true refuses a static-secret-only stream but accepts a grant", async () => {
    process.env.STREAM_REQUIRE_GRANT = "true";
    const c = await makeCall(A);
    const refused = await open({ callSid: c.providerCallId, token: SECRET });
    expect((await refused.closed).code).toBe(1008);
    expect(await claimRow(c.id)).toBeUndefined();

    const { grant } = await mint({ CallSid: c.providerCallId, CallTo: randomPhone(), Direction: "outbound-api" });
    const ok = await open({ callSid: c.providerCallId, grant });
    await ok.waitForMarks(1);
    expect((await claimRow(c.id))?.instanceId).toBe(lifecycle.instanceId);
  });

  it("without the opt-in nothing changes: a static-secret stream still attaches", async () => {
    const c = await makeCall(A);
    const p = await open({ callSid: c.providerCallId, token: SECRET });
    await p.waitForMarks(1);
    expect((await rowOf(c.id)).status).toBe("in_progress");
  });
});
