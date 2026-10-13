/**
 * Inbound calls over the real HTTP flow: the provider webhook, number -> agent routing, the media stream, and the
 * status callbacks that close the call. Tenant isolation, unknown numbers, the Sales module being optional, limits and
 * shutdown are all checked here. Only external providers are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { db } from "../../db/client.js";
import { auditLogs, calls, leads, usageEvents } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { agentPhoneNumbersRepository } from "../../db/repositories/agent-phone-numbers.repository.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { lifecycle } from "../../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { getCallRow, httpClient, randomPhone, relaxRateLimits, startTestApp, waitForSummary } from "../../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../../test/phone-socket.js";
import { agentPhoneNumbersService } from "../agents/agent-phone-numbers.service.js";
import { agentsService } from "../agents/agents.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

const SECRET = "a-long-random-webhook-secret-123";
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let A: TestTenant; // Sales on
let B: TestTenant; // Sales on, another organization
let C: TestTenant; // Sales OFF
let cookieA = "";
let cookieB = "";
let adminB = "";
let agentA = "";
let agentB = "";
let agentC = "";
let numA = "";
let numB = "";
let numC = "";
const phones: PhoneSocket[] = [];

const generic = (orgId: string, name: string) =>
  createDefaultAgent(orgId, { name, personaName: name, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });

/** The inbound webhook as Exotel calls it: GET with query parameters. */
function webhook(params: Record<string, string>, opts: { token?: string | null; method?: "GET" | "POST"; asJson?: boolean; headers?: Record<string, string> } = {}) {
  const token = opts.token === undefined ? null : opts.token;
  const query = new URLSearchParams({ ...(token ? { token } : {}), ...((opts.method ?? "GET") === "GET" ? params : {}) }).toString();
  const url = `${baseUrl}/api/telephony/exotel/inbound${query ? `?${query}` : ""}`;
  if ((opts.method ?? "GET") === "GET") return fetch(url, { headers: opts.headers });
  return fetch(url, {
    method: "POST",
    headers: { "content-type": opts.asJson ? "application/json" : "application/x-www-form-urlencoded", ...opts.headers },
    body: opts.asJson ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });
}
const sid = () => `CA${Math.random().toString(36).slice(2, 12)}`;
const callCount = async (orgId: string) => (await db.select().from(calls).where(eq(calls.organizationId, orgId))).length;

beforeAll(async () => {
  A = await createTenant("INB_A");
  B = await createTenant("INB_B");
  C = await createTenant("INB_C", { modules: [] });
  agentA = (await generic(A.orgId, "Asha")).id;
  agentB = (await generic(B.orgId, "Bina")).id;
  agentC = (await generic(C.orgId, "Chitra")).id;
  numA = randomPhone();
  numB = randomPhone();
  numC = randomPhone();
  await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agentA, phoneNumber: numA });
  await agentPhoneNumbersService.add(systemContext(B.orgId, "test"), { agentId: agentB, phoneNumber: numB });
  await agentPhoneNumbersService.add(systemContext(C.orgId, "test"), { agentId: agentC, phoneNumber: numC });
  const adminBM = await createMember(B.orgId, "ADMIN");
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  cookieA = await loginCookie(baseUrl, A.email);
  cookieB = await loginCookie(baseUrl, B.email);
  adminB = await loginCookie(baseUrl, adminBM.email);
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  vi.restoreAllMocks();
  lifecycle.reset();
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
  process.env.MAX_CONCURRENT_CALLS_PER_ORG = "100000";
});

describe("webhook authentication", () => {
  it("with a secret configured: no token or a wrong token is 401 and creates nothing; the right token (query or Basic) works", async () => {
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
    const before = await callCount(A.orgId);
    const params = { CallSid: sid(), CallTo: numA, CallFrom: randomPhone() };
    expect((await webhook(params)).status).toBe(401);
    expect((await webhook(params, { token: "wrong-token" })).status).toBe(401);
    expect(await callCount(A.orgId)).toBe(before);

    expect((await webhook(params, { token: SECRET })).status).toBe(200);
    const basic = `Basic ${Buffer.from(`exotel:${SECRET}`).toString("base64")}`;
    expect((await webhook({ ...params, CallSid: sid() }, { headers: { authorization: basic } })).status).toBe(200);
    expect(await callCount(A.orgId)).toBe(before + 2);
  });

  it("is reachable through a proxy like the other telephony endpoints", async () => {
    const res = await webhook({ CallSid: sid(), CallTo: numA, CallFrom: randomPhone() }, { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(res.status).toBe(200);
  });
});

describe("routing a number to its agent", () => {
  it("GET query, POST form and POST JSON all create an inbound call for the number's agent and organization", async () => {
    for (const variant of [{ method: "GET" as const }, { method: "POST" as const }, { method: "POST" as const, asJson: true }]) {
      const callSid = sid();
      const caller = randomPhone();
      const res = await webhook({ CallSid: callSid, CallTo: numA, CallFrom: caller }, variant);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; callId: string };
      expect(body.ok).toBe(true);

      const row = await getCallRow(body.callId);
      expect(row).toMatchObject({
        organizationId: A.orgId,
        agentId: agentA,
        callType: "inbound",
        status: "ringing",
        providerCallId: callSid,
        counterpartyNumber: caller,
        leadId: null,
        initiatedByUserId: null,
      });
      expect(await conversationsRepository.findByCallId({ organizationId: A.orgId, callId: body.callId })).not.toBeNull();
    }
  });

  it("is audited as call.received in the number's organization", async () => {
    const res = await webhook({ CallSid: sid(), CallTo: numA, CallFrom: randomPhone() });
    const { callId } = (await res.json()) as { callId: string };
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, A.orgId), eq(auditLogs.entityId, callId)));
    expect(rows.map((r) => r.action)).toContain("call.received");
  });

  it("is idempotent on CallSid: a provider retry returns the same call and creates no second record", async () => {
    const callSid = sid();
    const params = { CallSid: callSid, CallTo: numA, CallFrom: randomPhone() };
    const first = (await (await webhook(params)).json()) as { callId: string };
    const retry = (await (await webhook(params)).json()) as { callId: string };
    expect(retry.callId).toBe(first.callId);
    expect((await db.select().from(calls).where(eq(calls.providerCallId, callSid))).length).toBe(1);
  });

  it("matches the dialed number however the provider spells it (landline-style 0-prefixed, no plus, spaces)", async () => {
    const national = `80${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const landline = `+91${national}`;
    await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agentA, phoneNumber: landline });
    for (const spelling of [`0${national}`, `91${national}`, `+91 ${national.slice(0, 2)} ${national.slice(2)}`, landline]) {
      const res = await webhook({ CallSid: sid(), CallTo: spelling, CallFrom: randomPhone() });
      expect(res.status, spelling).toBe(200);
    }
  });

  it("an unparseable caller id does not stop the call being answered", async () => {
    const res = await webhook({ CallSid: sid(), CallTo: numA, CallFrom: "anonymous" });
    expect(res.status).toBe(200);
    const { callId } = (await res.json()) as { callId: string };
    expect((await getCallRow(callId)).counterpartyNumber).toBeNull();
  });
});

describe("unknown, unassigned and invalid numbers fail safely", () => {
  it("an unknown number is 404 and creates nothing in any organization", async () => {
    const before = [await callCount(A.orgId), await callCount(B.orgId), await callCount(C.orgId)];
    const res = await webhook({ CallSid: sid(), CallTo: randomPhone(), CallFrom: randomPhone() });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
    expect([await callCount(A.orgId), await callCount(B.orgId), await callCount(C.orgId)]).toEqual(before);
  });

  it("garbage in the dialed number is 404 (not a 500)", async () => {
    for (const bad of ["not-a-number", "12", "'; drop table calls; --"]) {
      expect((await webhook({ CallSid: sid(), CallTo: bad, CallFrom: randomPhone() })).status, bad).toBe(404);
    }
  });

  it("missing CallSid or CallTo is 400", async () => {
    expect((await webhook({ CallTo: numA })).status).toBe(400);
    expect((await webhook({ CallSid: sid() })).status).toBe(400);
  });

  it("a removed number stops answering; a number whose agent was archived is refused", async () => {
    const temp = randomPhone();
    const row = await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: agentA, phoneNumber: temp });
    expect((await webhook({ CallSid: sid(), CallTo: temp })).status).toBe(200);
    await agentPhoneNumbersService.remove(systemContext(A.orgId, "test"), { agentId: agentA, id: row.id });
    expect((await webhook({ CallSid: sid(), CallTo: temp })).status).toBe(404);

    const archived = (await generic(A.orgId, "Archived")).id;
    const archivedNumber = randomPhone();
    await agentPhoneNumbersService.add(systemContext(A.orgId, "test"), { agentId: archived, phoneNumber: archivedNumber });
    await agentsService.archive(systemContext(A.orgId, "test"), archived);
    const before = await callCount(A.orgId);
    expect((await webhook({ CallSid: sid(), CallTo: archivedNumber })).status).toBe(404);
    expect(await callCount(A.orgId)).toBe(before);
  });
});

describe("tenant isolation", () => {
  it("each number reaches only its own organization; nothing in the payload can pick another tenant", async () => {
    const forgedParams = {
      CallSid: sid(),
      CallTo: numB,
      CallFrom: randomPhone(),
      // Attempts to steer the call into organization A / agent A:
      organizationId: A.orgId,
      OrganizationId: A.orgId,
      orgId: A.orgId,
      agentId: agentA,
      AgentId: agentA,
    };
    const res = await webhook(forgedParams);
    expect(res.status).toBe(200);
    const { callId } = (await res.json()) as { callId: string };
    const row = await getCallRow(callId);
    expect(row.organizationId).toBe(B.orgId);
    expect(row.agentId).toBe(agentB);

    // Visible to B, invisible to A.
    expect((await http(cookieB, "GET", `/api/calls/${callId}`)).status).toBe(200);
    expect((await http(cookieA, "GET", `/api/calls/${callId}`)).status).toBe(404);
    const listA = await http(cookieA, "GET", "/api/calls?callType=inbound&limit=100");
    expect(listA.body.data.map((c: { id: string }) => c.id)).not.toContain(callId);
  });

  it("a caller whose number matches ANOTHER organization's lead never gets that lead attached", async () => {
    const shared = randomPhone();
    await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "A's lead", phone: shared });
    const res = await webhook({ CallSid: sid(), CallTo: numB, CallFrom: shared });
    const { callId } = (await res.json()) as { callId: string };
    expect((await getCallRow(callId)).leadId).toBeNull();
  });

  it("another organization's admin cannot see, add or remove the numbers of this organization's agent", async () => {
    const list = await http(adminB, "GET", `/api/agents/${agentA}/phone-numbers`);
    expect(list.status).toBe(404);
    expect((await http(adminB, "POST", `/api/agents/${agentA}/phone-numbers`, { phoneNumber: randomPhone() })).status).toBe(404);
    const row = await agentPhoneNumbersRepository.findByNumberAnyOrg({ phoneNumber: numA });
    expect((await http(adminB, "DELETE", `/api/agents/${agentA}/phone-numbers/${row!.id}`)).status).toBe(404);
    expect(await agentPhoneNumbersRepository.findByNumberAnyOrg({ phoneNumber: numA })).not.toBeNull();
  });
});

describe("Sales is optional", () => {
  it("a generic agent in an organization with Sales OFF answers inbound calls; a lead with the caller's number is not attached", async () => {
    const phone = randomPhone();
    await db.insert(leads).values({ organizationId: C.orgId, projectId: C.projectId, name: "C's lead", phone });
    const res = await webhook({ CallSid: sid(), CallTo: numC, CallFrom: phone });
    expect(res.status).toBe(200);
    const row = await getCallRow(((await res.json()) as { callId: string }).callId);
    expect(row).toMatchObject({ organizationId: C.orgId, agentId: agentC, callType: "inbound", leadId: null, counterpartyNumber: phone });
  });

  it("with Sales ON, a caller who is exactly one lead of that organization is recognised", async () => {
    const phone = randomPhone();
    const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Known caller", phone }).returning();
    const res = await webhook({ CallSid: sid(), CallTo: numA, CallFrom: phone });
    expect((await getCallRow(((await res.json()) as { callId: string }).callId)).leadId).toBe(lead.id);
  });
});

describe("limits and shutdown apply to inbound calls", () => {
  it("over the organization's concurrent limit: 429 with a code, nothing created, other organizations still answered", async () => {
    const D = await createTenant("INB_D");
    const agentD = (await generic(D.orgId, "Dev")).id;
    const numD = randomPhone();
    await agentPhoneNumbersService.add(systemContext(D.orgId, "test"), { agentId: agentD, phoneNumber: numD });
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "1";

    expect((await webhook({ CallSid: sid(), CallTo: numD, CallFrom: randomPhone() })).status).toBe(200);
    const before = await callCount(D.orgId);
    const refused = await webhook({ CallSid: sid(), CallTo: numD, CallFrom: randomPhone() });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ ok: false, code: "CONCURRENT_CALL_LIMIT" });
    expect(await callCount(D.orgId)).toBe(before);

    // Organization B's own number is still answered under the same setting (B has no active calls yet).
    const activeB = await db.select().from(calls).where(and(eq(calls.organizationId, B.orgId), eq(calls.status, "ringing")));
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = String(activeB.length + 1);
    expect((await webhook({ CallSid: sid(), CallTo: numB, CallFrom: randomPhone() })).status).toBe(200);
  });

  it("while the server is draining a NEW inbound call is 503 SHUTTING_DOWN, but a retry of an already-announced call is still answered", async () => {
    const known = sid();
    expect((await webhook({ CallSid: known, CallTo: numA, CallFrom: randomPhone() })).status).toBe(200);
    lifecycle.beginDrain();
    const before = await callCount(A.orgId);
    const fresh = await webhook({ CallSid: sid(), CallTo: numA, CallFrom: randomPhone() });
    expect(fresh.status).toBe(503);
    expect(await fresh.json()).toMatchObject({ code: "SHUTTING_DOWN" });
    expect(await callCount(A.orgId)).toBe(before);
    expect((await webhook({ CallSid: known, CallTo: numA, CallFrom: randomPhone() })).status).toBe(200);
  });

  it("an internal failure is 500 (so the provider retries) and creates nothing; the retry then succeeds", async () => {
    const callSid = sid();
    const params = { CallSid: callSid, CallTo: numA, CallFrom: randomPhone() };
    vi.spyOn(agentPhoneNumbersRepository, "findByNumberAnyOrg").mockRejectedValueOnce(new Error("database is down"));
    const before = await callCount(A.orgId);
    const failed = await webhook(params);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "Internal server error", requestId: expect.any(String) });
    expect(await callCount(A.orgId)).toBe(before);
    expect((await webhook(params)).status).toBe(200);
    expect(await callCount(A.orgId)).toBe(before + 1);
  });
});

describe("the whole inbound call, over the media stream", () => {
  it("webhook -> media stream finds the call by call_sid -> the generic agent greets -> status callbacks close it -> summary and usage", async () => {
    const callSid = sid();
    const { callId } = (await (await webhook({ CallSid: callSid, CallTo: numA, CallFrom: randomPhone() })).json()) as { callId: string };

    const phone = await openPhone(baseUrl, { callSid }); // no internalCallId: the call is found by its call_sid
    phones.push(phone);
    await phone.waitForMarks(1);
    expect(lifecycle.liveCallCount()).toBe(1);
    const transcript = (await conversationsRepository.findByCallId({ organizationId: A.orgId, callId }))!.transcript as Array<{ speaker: string; text: string }>;
    expect(transcript[0].speaker).toBe("ai");
    expect(transcript[0].text.length).toBeGreaterThan(0);

    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/telephony/exotel/status-callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post({ providerCallId: callSid, status: "in_progress" });
    expect((await getCallRow(callId)).status).toBe("in_progress");
    await phone.hangUp();
    await post({ providerCallId: callSid, status: "completed", durationSeconds: 42 });

    const conv = await waitForSummary(A.orgId, callId);
    expect((conv.qualification as { profile?: string }).profile).toBe("generic");
    const row = await getCallRow(callId);
    expect(row).toMatchObject({ status: "completed", callType: "inbound", organizationId: A.orgId, agentId: agentA });
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.callId, callId));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.organizationId === A.orgId)).toBe(true);
    expect(lifecycle.liveCallCount()).toBe(0);
  });

  it("an inbound call that arrives straight on the media stream (no webhook first) is routed by the `to` number", async () => {
    const callSid = sid();
    const caller = randomPhone();
    const before = await callCount(B.orgId);
    const phone = await openPhone(baseUrl, { callSid, to: numB, from: caller });
    phones.push(phone);
    await phone.waitForMarks(1);

    const rows = await db.select().from(calls).where(eq(calls.providerCallId, callSid));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: B.orgId, agentId: agentB, callType: "inbound", counterpartyNumber: caller });
    expect(await callCount(B.orgId)).toBe(before + 1);
  });

  it("a media stream for a number nobody answers is closed and creates nothing", async () => {
    const before = [await callCount(A.orgId), await callCount(B.orgId), await callCount(C.orgId)];
    const phone = await openPhone(baseUrl, { callSid: sid(), to: randomPhone(), from: randomPhone() });
    phones.push(phone);
    await phone.closed; // the handler waits briefly for an outbound call record, then gives up
    expect(phone.marks).toHaveLength(0);
    expect([await callCount(A.orgId), await callCount(B.orgId), await callCount(C.orgId)]).toEqual(before);
  }, 20_000);
});
