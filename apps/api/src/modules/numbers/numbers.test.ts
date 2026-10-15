/**
 * Telephony number management over real HTTP and PostgreSQL (restricted runtime role, forced RLS): inventory,
 * assignment, pause/resume with confirmation, the real inbound webhook honouring pause, refused-attempt recording
 * (idempotent on CallSid), calls per number, tenant isolation, permissions and the connection check. The Exotel
 * number lookup is tested against a stubbed HTTP response (no real Exotel account here); nothing else is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db } from "../../db/client.js";
import { agentPhoneNumbers, calls } from "../../db/schema.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { ExotelProvider } from "../../adapters/telephony/exotel.provider.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { httpClient, randomPhone, relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { resetNumberCheckCooldowns } from "./numbers.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let B: TestTenant;
let ownerA = "";
let managerA = "";
let agentRoleA = "";
let ownerB = "";
let asha = "";
let ravi = "";
let archived = "";
let agentB = "";

const generic = (orgId: string, name: string) =>
  createDefaultAgent(orgId, { name, personaName: name, promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
const sid = () => `CA${Math.random().toString(36).slice(2, 12)}`;
const inbound = (to: string, callSid = sid()) =>
  fetch(`${baseUrl}/api/telephony/exotel/inbound?${new URLSearchParams({ CallSid: callSid, CallTo: to, CallFrom: randomPhone() })}`);

beforeAll(async () => {
  A = await createTenant("NUM_A");
  B = await createTenant("NUM_B");
  asha = (await generic(A.orgId, "Asha")).id;
  ravi = (await generic(A.orgId, "Ravi")).id;
  archived = (await generic(A.orgId, "Old")).id;
  agentB = (await generic(B.orgId, "Bina")).id;
  const manager = await createMember(A.orgId, "MANAGER");
  const agentUser = await createMember(A.orgId, "AGENT");
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  ownerA = await loginCookie(baseUrl, A.email);
  ownerB = await loginCookie(baseUrl, B.email);
  managerA = await loginCookie(baseUrl, manager.email);
  agentRoleA = await loginCookie(baseUrl, agentUser.email);
  expect((await http(ownerA, "POST", `/api/agents/${archived}/archive`, {})).status).toBe(200);
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetNumberCheckCooldowns();
});

async function addNumber(cookie: string, agentId: string, phoneNumber = randomPhone(), label: string | null = null) {
  const res = await http(cookie, "POST", "/api/numbers", { phoneNumber, agentId, label });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; phoneNumber: string; state: string; agent: { id: string } };
}

describe("inventory and assignment", () => {
  it("adds a number to an active agent, normalizes it and lists it with its agent, state and provider setup", async () => {
    const local = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const n = await addNumber(ownerA, asha, local, "Front desk");
    expect(n.phoneNumber).toBe(`+91${local}`);
    expect(n.state).toBe("active");
    const list = await http(ownerA, "GET", "/api/numbers");
    expect(list.status).toBe(200);
    const data = list.body.data as { provider: { provider: string; simulated: boolean }; numbers: Array<{ id: string; label: string; agent: { name: string } }> };
    expect(data.provider).toMatchObject({ provider: "mock", simulated: true });
    expect(data.numbers.find((x) => x.id === n.id)).toMatchObject({ label: "Front desk", agent: { name: "Asha" } });
  });

  it("refuses invalid numbers, archived agents, another organization's agent and unknown fields", async () => {
    expect((await http(ownerA, "POST", "/api/numbers", { phoneNumber: "hello", agentId: asha })).status).toBe(400);
    expect((await http(ownerA, "POST", "/api/numbers", { phoneNumber: randomPhone(), agentId: archived })).status).toBe(400);
    expect((await http(ownerA, "POST", "/api/numbers", { phoneNumber: randomPhone(), agentId: agentB })).status).toBe(404);
    expect((await http(ownerA, "POST", "/api/numbers", { phoneNumber: randomPhone(), agentId: asha, organizationId: B.orgId })).status).toBe(400);
  });

  it("a number held by another organization is refused without revealing anything about it", async () => {
    const theirs = await addNumber(ownerB, agentB);
    const res = await http(ownerA, "POST", "/api/numbers", { phoneNumber: theirs.phoneNumber, agentId: asha });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("This number cannot be added. If it belongs to you, contact support.");
    const mine = await addNumber(ownerA, asha);
    const dup = await http(ownerA, "POST", "/api/numbers", { phoneNumber: mine.phoneNumber, agentId: ravi });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("already in your numbers");
  });
});

describe("routing changes need confirmation and are race-safe", () => {
  it("reassigning an active number without confirm is refused and changes nothing; with confirm it moves", async () => {
    const n = await addNumber(ownerA, asha);
    const refused = await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { agentId: ravi });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('answered by "Ravi" instead of "Asha"');
    expect((await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data.agent.id).toBe(asha);

    const moved = await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { agentId: ravi, expectedAgentId: asha, confirm: true });
    expect(moved.status).toBe(200);
    expect(moved.body.data.agent.id).toBe(ravi);
    // A stale editor (still thinks Asha answers) cannot overwrite the change.
    const stale = await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { agentId: asha, expectedAgentId: asha, confirm: true });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("changed by someone else");
    // Label edits need no confirmation; reassigning to an archived agent is refused.
    expect((await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { label: "Sales line" })).body.data.label).toBe("Sales line");
    expect((await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { agentId: archived, confirm: true })).status).toBe(400);
  });

  it("pausing needs confirmation; a paused number refuses real inbound webhooks and records the attempt once per CallSid", async () => {
    const n = await addNumber(ownerA, asha);
    expect((await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { routingEnabled: false })).status).toBe(409);
    const paused = await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { routingEnabled: false, confirm: true });
    expect(paused.body.data.state).toBe("paused");

    const callSid = sid();
    expect((await inbound(n.phoneNumber, callSid)).status).toBe(404);
    expect((await inbound(n.phoneNumber, callSid)).status).toBe(404); // provider retry of the same call
    expect(await db.select().from(calls).where(eq(calls.providerCallId, callSid))).toHaveLength(0);
    let detail = (await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data;
    expect(detail.refused).toMatchObject({ count: 1, lastReason: "paused" });
    expect((await inbound(n.phoneNumber)).status).toBe(404);
    detail = (await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data;
    expect(detail.refused.count).toBe(2);

    // Resuming needs no confirmation and calls are answered again, recorded against the number.
    expect((await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { routingEnabled: true })).body.data.state).toBe("active");
    const ok = await inbound(n.phoneNumber);
    expect(ok.status).toBe(200);
    const { callId } = (await ok.json()) as { callId: string };
    const [row] = await db.select().from(calls).where(eq(calls.id, callId));
    expect(row.lineNumber).toBe(n.phoneNumber);
    detail = (await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data;
    expect(detail.lastInboundAt).toBeTruthy();
    expect(detail.calls.total).toBe(1);
    expect(detail.recentCalls.map((c: { id: string }) => c.id)).toContain(callId);
  });

  it("calls and failures per number: a failed call on the line is counted and listed", async () => {
    const n = await addNumber(ownerA, asha);
    const res = await inbound(n.phoneNumber);
    const { callId } = (await res.json()) as { callId: string };
    await db.update(calls).set({ status: "failed", endedAt: new Date() }).where(eq(calls.id, callId));
    const detail = (await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data;
    expect(detail.calls).toMatchObject({ total: 1, failed: 1, live: 0 });
    expect(detail.recentFailures.map((c: { id: string }) => c.id)).toEqual([callId]);
  });

  it("an archived answering agent shows as agent_inactive and the inbound attempt is recorded as refused", async () => {
    const temp = (await generic(A.orgId, "Temp")).id;
    const n = await addNumber(ownerA, temp);
    expect((await http(ownerA, "POST", `/api/agents/${temp}/archive`, {})).status).toBe(200);
    expect((await inbound(n.phoneNumber)).status).toBe(404);
    const detail = (await http(ownerA, "GET", `/api/numbers/${n.id}`)).body.data;
    expect(detail.state).toBe("agent_inactive");
    expect(detail.refused.lastReason).toBe("agent_inactive");
  });

  it("removing an active number needs confirmation; afterwards calls to it are not answered", async () => {
    const n = await addNumber(ownerA, asha);
    expect((await http(ownerA, "DELETE", `/api/numbers/${n.id}`)).status).toBe(409);
    expect((await http(ownerA, "DELETE", `/api/numbers/${n.id}?confirm=true`)).status).toBe(204);
    expect((await inbound(n.phoneNumber)).status).toBe(404);
    expect((await http(ownerA, "GET", `/api/numbers/${n.id}`)).status).toBe(404);
  });
});

describe("tenant isolation and permissions", () => {
  it("another organization's number is not found for every operation and never listed", async () => {
    const theirs = await addNumber(ownerB, agentB);
    expect((await http(ownerA, "GET", `/api/numbers/${theirs.id}`)).status).toBe(404);
    expect((await http(ownerA, "PATCH", `/api/numbers/${theirs.id}`, { label: "x" })).status).toBe(404);
    expect((await http(ownerA, "PATCH", `/api/numbers/${theirs.id}`, { routingEnabled: false, confirm: true })).status).toBe(404);
    expect((await http(ownerA, "DELETE", `/api/numbers/${theirs.id}?confirm=true`)).status).toBe(404);
    expect((await http(ownerA, "POST", `/api/numbers/${theirs.id}/check`, {})).status).toBe(404);
    const list = (await http(ownerA, "GET", "/api/numbers")).body.data as { numbers: Array<{ id: string; phoneNumber: string }> };
    expect(list.numbers.some((x) => x.id === theirs.id || x.phoneNumber === theirs.phoneNumber)).toBe(false);
    const [row] = await db.select().from(agentPhoneNumbers).where(eq(agentPhoneNumbers.id, theirs.id));
    expect(row).toMatchObject({ organizationId: B.orgId, routingEnabled: true, label: null });
  });

  it("a manager can read but not change or check; an agent-role user cannot read; no login is 401", async () => {
    const n = await addNumber(ownerA, asha);
    expect((await http(managerA, "GET", "/api/numbers")).status).toBe(200);
    expect((await http(managerA, "GET", `/api/numbers/${n.id}`)).status).toBe(200);
    expect((await http(managerA, "POST", "/api/numbers", { phoneNumber: randomPhone(), agentId: asha })).status).toBe(403);
    expect((await http(managerA, "PATCH", `/api/numbers/${n.id}`, { routingEnabled: false, confirm: true })).status).toBe(403);
    expect((await http(managerA, "DELETE", `/api/numbers/${n.id}?confirm=true`)).status).toBe(403);
    expect((await http(managerA, "POST", `/api/numbers/${n.id}/check`, {})).status).toBe(403);
    expect((await http(agentRoleA, "GET", "/api/numbers")).status).toBe(403);
    expect((await http("", "GET", "/api/numbers")).status).toBe(401);
  });
});

describe("connection check", () => {
  it("with the simulated provider: routing steps pass, provider steps say it is simulated, never 'verified'", async () => {
    const n = await addNumber(ownerA, asha);
    const res = await http(ownerA, "POST", `/api/numbers/${n.id}/check`, {});
    expect(res.status).toBe(200);
    const steps = res.body.data.steps as Array<{ key: string; status: string; detail: string }>;
    expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toEqual({
      routing: "pass",
      agent: "pass",
      lookup: "pass",
      provider: "warn",
      provider_number: "skip",
    });
    expect(res.body.data.number.provider.status).toBe("unsupported");
    // Rate limited per number.
    expect((await http(ownerA, "POST", `/api/numbers/${n.id}/check`, {})).status).toBe(409);
  });

  it("a paused number fails the routing step with an action", async () => {
    const n = await addNumber(ownerA, asha);
    await http(ownerA, "PATCH", `/api/numbers/${n.id}`, { routingEnabled: false, confirm: true });
    const res = await http(ownerA, "POST", `/api/numbers/${n.id}/check`, {});
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.steps[0]).toMatchObject({ key: "routing", status: "fail" });
  });

  it("with Exotel configured: the number is looked up in the account's ExoPhone list; only its own fields are reported", async () => {
    const env = {
      EXOTEL_API_KEY: "key-xyz",
      EXOTEL_API_TOKEN: "token-secret-xyz",
      EXOTEL_ACCOUNT_SID: "acct1",
      EXOTEL_SUBDOMAIN: "api.in.exotel.com",
      EXOTEL_FROM_NUMBER: "+918000000000",
      EXOTEL_WEBHOOK_BASE_URL: "https://voice.example.test",
      EXOTEL_AGENTSTREAM_WEBHOOK_SECRET: "",
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    setTelephonyProvider(new ExotelProvider());
    const n = await addNumber(ownerA, asha);
    const other = "+918011111111";
    const seen: Array<{ url: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("exotel.com")) return realFetch(input, init);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            page: 0,
            page_size: 50,
            incoming_phone_numbers: [
              { sid: "s1", phone_number: other, friendly_name: "08011111111", capabilities: { voice: true }, voice_url: "https://my.exotel.com/exoml/start/9" },
              { sid: "s2", phone_number: n.phoneNumber, friendly_name: "x", capabilities: { voice: true, sms: false }, voice_url: "https://my.exotel.com/exoml/start/7" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    try {
      const res = await http(ownerA, "POST", `/api/numbers/${n.id}/check`, {});
      expect(res.status).toBe(200);
      expect(seen[0].url).toBe("https://api.in.exotel.com/v2_beta/Accounts/acct1/IncomingPhoneNumbers");
      expect(seen[0].auth).toBe(`Basic ${Buffer.from("key-xyz:token-secret-xyz").toString("base64")}`);
      const step = (res.body.data.steps as Array<{ key: string; status: string }>).find((s) => s.key === "provider_number");
      expect(step?.status).toBe("pass");
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(other); // the account's other numbers never reach the tenant
      expect(text).not.toContain("token-secret-xyz");
      expect(text).not.toContain("key-xyz");

      // Provider failures are reported, stored and never thrown: 401, timeout, malformed, missing.
      const cases: Array<[() => Promise<Response>, RegExp]> = [
        [() => Promise.resolve(new Response("denied", { status: 401 })), /refused the platform's API credentials/],
        [() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), /did not answer within 10 seconds/],
        [() => Promise.resolve(new Response("<html>", { status: 200 })), /does not understand/],
        [() => Promise.resolve(new Response(JSON.stringify({ page: 0, page_size: 50, incoming_phone_numbers: [] }), { status: 200 })), /not on the platform's Exotel account/],
      ];
      for (const [respond, expected] of cases) {
        resetNumberCheckCooldowns();
        vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => (String(input).includes("exotel.com") ? respond() : realFetch(input, init)));
        const r = await http(ownerA, "POST", `/api/numbers/${n.id}/check`, {});
        expect(r.status).toBe(200);
        const s = (r.body.data.steps as Array<{ key: string; status: string; detail: string }>).find((x) => x.key === "provider_number");
        expect(s?.status).toBe("fail");
        expect(s?.detail).toMatch(expected);
        expect(r.body.data.number.provider.detail).toMatch(expected);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      setTelephonyProvider(null);
    }
  });
});
