/**
 * Exotel "App Bazaar flow" support (Greeting -> Voicebot applet):
 *  - outbound calls placed INTO the flow (EXOTEL_FLOW_APP_ID) instead of passing StreamUrl/StreamType;
 *  - the audio stream itself drives the call lifecycle, because calls that arrive through an ExoPhone flow often have
 *    no Exotel status callbacks at all: answered when the stream starts, finished (summary, usage) when it ends.
 * Only external providers are mocked; the HTTP/WebSocket flow and Postgres are real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { adminDb as db } from "../../db/client.js";
import { calls, usageEvents } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { ExotelProvider } from "../../adapters/telephony/exotel.provider.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { callsRepository } from "../../test/repos.js";
import { conversationsRepository } from "../../test/repos.js";
import { lifecycle } from "../../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../test/tenants.js";
import { getCallRow, randomPhone, relaxRateLimits, startTestApp, waitForSummary } from "../../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../../test/phone-socket.js";
import { agentPhoneNumbersService } from "../agents/agent-phone-numbers.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

describe("outbound calls placed into an App Bazaar flow", () => {
  const ENV: Record<string, string> = {
    EXOTEL_API_KEY: "test-key",
    EXOTEL_API_TOKEN: "test-token",
    EXOTEL_ACCOUNT_SID: "acme1",
    EXOTEL_SUBDOMAIN: "api.exotel.com",
    EXOTEL_FROM_NUMBER: "0XXXXXXXXXX",
    EXOTEL_WEBHOOK_BASE_URL: "https://abc.ngrok-free.dev",
    EXOTEL_AGENTSTREAM_WEBHOOK_SECRET: "s3cret",
  };
  const KEYS = [...Object.keys(ENV), "EXOTEL_FLOW_APP_ID", "EXOTEL_FLOW_URL_BASE", "EXOTEL_CALL_TYPE"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
    delete process.env.EXOTEL_FLOW_APP_ID;
    delete process.env.EXOTEL_FLOW_URL_BASE;
    delete process.env.EXOTEL_CALL_TYPE;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const build = () => new ExotelProvider().buildConnectRequest({ toNumber: "+919000000001", internalCallId: "call-1" }, "signed.stream.token");

  it("with EXOTEL_FLOW_APP_ID the customer is connected to the flow: Url set, no StreamUrl/StreamType", () => {
    process.env.EXOTEL_FLOW_APP_ID = "1178749";
    const body = build();
    expect(body.get("Url")).toBe("http://my.exotel.com/acme1/exoml/start_voice/1178749");
    expect(body.get("StreamUrl")).toBeNull();
    expect(body.get("StreamType")).toBeNull();
    expect(body.get("From")).toBe("+919000000001"); // the customer
    expect(body.get("CallerId")).toBe("0XXXXXXXXXX"); // the ExoPhone
    expect(body.get("To")).toBeNull();
  });

  it("still sends the authenticated status callback with answered + terminal events in flow mode", () => {
    process.env.EXOTEL_FLOW_APP_ID = "1178749";
    const body = build();
    const cb = new URL(body.get("StatusCallback")!);
    expect(cb.pathname).toBe("/api/telephony/exotel/status-callback");
    expect(cb.searchParams.get("token")).toBe("s3cret");
    expect(body.get("StatusCallbackEvents[0]")).toBe("terminal");
    expect(body.get("StatusCallbackEvents[1]")).toBe("answered");
    expect(body.get("StatusCallbackContentType")).toBe("application/json");
  });

  it("the flow URL base is configurable and tolerates a trailing slash", () => {
    process.env.EXOTEL_FLOW_APP_ID = "42";
    process.env.EXOTEL_FLOW_URL_BASE = "https://my.in.exotel.com/";
    expect(build().get("Url")).toBe("https://my.in.exotel.com/acme1/exoml/start_voice/42");
  });

  it("without EXOTEL_FLOW_APP_ID nothing changes: the Connect Voice AI parameters are sent and no Url", () => {
    const body = build();
    expect(body.get("Url")).toBeNull();
    expect(body.get("StreamType")).toBe("bidirectional");
    const stream = new URL(body.get("StreamUrl")!);
    expect(stream.protocol).toBe("wss:");
    expect(stream.searchParams.get("st")).toBe("signed.stream.token");
  });
});

describe("the media stream drives the call lifecycle (calls through an ExoPhone flow have no callbacks)", () => {
  let app: Awaited<ReturnType<typeof startTestApp>>["app"];
  let baseUrl: string;
  let T: TestTenant;
  let agentId = "";
  let exoPhone = "";
  const phones: PhoneSocket[] = [];
  const sid = () => `CAflow${Math.random().toString(36).slice(2, 12)}`;
  const callBySid = async (callSid: string) => (await db.select().from(calls).where(eq(calls.providerCallId, callSid)))[0];
  const usageFor = async (callId: string) => (await db.select().from(usageEvents).where(eq(usageEvents.callId, callId))).length;
  /** Finalization writes the usage rows just AFTER the summary; wait until the count stops changing. */
  async function settledUsage(callId: string) {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = await usageFor(callId);
      if (n === last && n > 0) return n;
      last = n;
      await new Promise((r) => setTimeout(r, 150));
    }
    return last;
  }
  async function until<V>(fn: () => Promise<V | undefined | false>, what: string, ms = 10_000): Promise<V> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    T = await createTenant("FLOW_A");
    agentId = (
      await createDefaultAgent(T.orgId, { name: "Flow agent", personaName: "Asha", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
    ).id;
    exoPhone = randomPhone();
    await agentPhoneNumbersService.add(systemContext(T.orgId, "test"), { agentId, phoneNumber: exoPhone });
    ({ app, baseUrl } = await startTestApp());
  });
  afterAll(async () => {
    setTelephonyProvider(null);
    await app.close();
    await cleanupTenants();
  });
  afterEach(async () => {
    for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
    lifecycle.reset();
  });

  it("answered when the stream starts, finished with summary and usage when it ends, with NO status callback at all", async () => {
    const callSid = sid();
    const phone = await openPhone(baseUrl, { callSid, to: exoPhone, from: randomPhone() });
    phones.push(phone);
    await phone.waitForMarks(1);

    const live = await until(async () => {
      const c = await callBySid(callSid);
      return c?.status === "in_progress" ? c : undefined;
    }, "the call to become in_progress");
    expect(live.startedAt).toBeTruthy();
    expect(live.endedAt).toBeNull();
    expect(live.callType).toBe("inbound");

    await phone.hangUp();
    await waitForSummary(T.orgId, live.id);
    const done = await getCallRow(live.id);
    expect(done.status).toBe("completed");
    expect(done.endedAt).toBeTruthy();
    expect(await settledUsage(live.id)).toBeGreaterThan(0);
  });

  it("a late Exotel callback for the same call is a harmless duplicate: nothing is finalized or counted twice", async () => {
    const callSid = sid();
    const phone = await openPhone(baseUrl, { callSid, to: exoPhone, from: randomPhone() });
    phones.push(phone);
    await phone.waitForMarks(1);
    const call = (await until(async () => callBySid(callSid), "the call record"))!;
    await phone.hangUp();
    await waitForSummary(T.orgId, call.id);
    const before = await getCallRow(call.id);
    const usageBefore = await settledUsage(call.id);
    const summaryBefore = (await conversationsRepository.findByCallId({ organizationId: T.orgId, callId: call.id }))!.summary;

    for (const status of ["completed", "completed"]) {
      const res = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerCallId: callSid, status, durationSeconds: 77 }),
      });
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 300));

    const after = await getCallRow(call.id);
    expect(after.endedAt).toEqual(before.endedAt);
    expect(after.status).toBe("completed");
    expect(await usageFor(call.id)).toBe(usageBefore);
    expect((await conversationsRepository.findByCallId({ organizationId: T.orgId, callId: call.id }))!.summary).toBe(summaryBefore);
  });

  it("a stream that drops abruptly, with no stop event, still ends the call and finalizes it", async () => {
    const callSid = sid();
    const phone = await openPhone(baseUrl, { callSid, to: exoPhone, from: randomPhone() });
    phones.push(phone);
    await phone.waitForMarks(1);
    const call = (await until(async () => callBySid(callSid), "the call record"))!;
    phone.ws.terminate(); // network loss: no stop frame, no close handshake

    await waitForSummary(T.orgId, call.id);
    expect((await getCallRow(call.id)).status).toBe("completed");
  });

  it("an OUTBOUND call placed into the flow is not mistaken for a new inbound call, even though its `to` is our ExoPhone", async () => {
    const callSid = sid();
    const customer = randomPhone();
    const outbound = await callsRepository.create({
      organizationId: T.orgId,
      agentId,
      status: "ringing",
      callType: "outbound",
      providerCallId: callSid,
      counterpartyNumber: customer,
    });
    await conversationsRepository.createForCall({ organizationId: T.orgId, callId: outbound.id });

    // Through a flow, Exotel may report the ExoPhone as `to`. The call is already ours (found by call_sid first).
    const phone = await openPhone(baseUrl, { callSid, to: exoPhone, from: customer });
    phones.push(phone);
    await phone.waitForMarks(1);

    const rows = await db.select().from(calls).where(eq(calls.providerCallId, callSid));
    expect(rows).toHaveLength(1); // no duplicate inbound record
    expect(rows[0].id).toBe(outbound.id);
    expect(rows[0].callType).toBe("outbound");
    await until(async () => ((await getCallRow(outbound.id)).status === "in_progress" ? true : undefined), "in_progress");

    await phone.hangUp();
    await waitForSummary(T.orgId, outbound.id);
    expect((await getCallRow(outbound.id)).status).toBe("completed");
  });
});
