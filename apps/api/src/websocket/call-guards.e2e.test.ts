/**
 * The silence timeout and maximum call duration through the REAL media-stream WebSocket handler (mock STT/LLM/TTS),
 * plus live-call draining during shutdown. A bare "phone" (test/phone-socket.ts) hears the agent and says nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { systemContext } from "../auth/context.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { gracefulShutdown } from "../runtime/shutdown.js";
import { cleanupTenants, createDefaultAgent, createTenant, loginCookie, type TestTenant } from "../test/tenants.js";
import { httpClient, relaxRateLimits, startTestApp } from "../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../test/phone-socket.js";
import { callsService } from "../modules/calls/calls.service.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let agentId = "";
let cookie = "";
const phones: PhoneSocket[] = [];

async function newCall() {
  return callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000044444" });
}
async function connect(callSid: string) {
  const call = await newCall();
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  return { call, phone };
}

beforeAll(async () => {
  A = await createTenant("GRD_A");
  agentId = (
    await createDefaultAgent(A.orgId, { name: "Guard agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
  ).id;
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  cookie = await loginCookie(baseUrl, A.email);
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  lifecycle.reset();
  process.env.SILENCE_TIMEOUT_MS = "0";
  process.env.SILENCE_REPROMPTS = "1";
  process.env.MAX_CALL_DURATION_MS = "0";
});

describe("silence timeout", () => {
  it("reprompts once, then says goodbye and hangs up on a call nobody speaks on", async () => {
    process.env.SILENCE_TIMEOUT_MS = "400";
    process.env.SILENCE_REPROMPTS = "1";
    const { phone } = await connect("grd-silence-1");

    const closed = await phone.closed;
    // Heard: the opening line, "are you still there?", then the goodbye (each ends with a mark), then the line closes.
    expect(phone.marks.length).toBe(3);
    // The reprompt and the goodbye each waited about one silence period.
    expect(phone.marks[1].atMs - phone.marks[0].atMs).toBeGreaterThanOrEqual(350);
    expect(phone.marks[2].atMs - phone.marks[1].atMs).toBeGreaterThanOrEqual(350);
    expect(closed.atMs).toBeLessThan(15_000);
    expect(lifecycle.liveCallCount()).toBe(0); // the call unregistered when it ended
  });

  it("with SILENCE_REPROMPTS=0 it goes straight to goodbye", async () => {
    process.env.SILENCE_TIMEOUT_MS = "300";
    process.env.SILENCE_REPROMPTS = "0";
    const { phone } = await connect("grd-silence-2");
    await phone.closed;
    expect(phone.marks.length).toBe(2); // opening + goodbye
  });

  it("disabled (0): a quiet call is left alone", async () => {
    process.env.SILENCE_TIMEOUT_MS = "0";
    const { phone } = await connect("grd-silence-3");
    await phone.waitForMarks(1);
    await new Promise((r) => setTimeout(r, 800));
    expect(phone.isOpen()).toBe(true);
    expect(phone.marks.length).toBe(1);
  });
});

describe("maximum call duration", () => {
  it("ends the call with a goodbye once it has run for the limit, even though the customer keeps the line", async () => {
    process.env.MAX_CALL_DURATION_MS = "900";
    process.env.SILENCE_TIMEOUT_MS = "0";
    const { phone } = await connect("grd-max-1");
    const closed = await phone.closed;
    expect(phone.marks.length).toBe(2); // opening + the "maximum time" goodbye
    expect(closed.atMs).toBeGreaterThanOrEqual(850);
    expect(closed.atMs).toBeLessThan(15_000);
  });

  it("a RUNNING call keeps the limit it started with; a call that starts later gets the new one", async () => {
    process.env.MAX_CALL_DURATION_MS = "60000";
    const first = await connect("grd-max-2a");
    await first.phone.waitForMarks(1);

    process.env.MAX_CALL_DURATION_MS = "500"; // the limit is lowered while call 1 is live
    await new Promise((r) => setTimeout(r, 1_200));
    expect(first.phone.isOpen()).toBe(true); // call 1 is unaffected
    expect(first.phone.marks.length).toBe(1);

    const second = await connect("grd-max-2b"); // call 2 starts under the new limit
    const closed = await second.phone.closed;
    expect(closed.atMs).toBeLessThan(10_000);
    expect(second.phone.marks.length).toBe(2);
    expect(first.phone.isOpen()).toBe(true);
  });
});

describe("shutdown with a live call", () => {
  it("draining refuses new calls and turns readiness red, but the live call keeps talking until it ends", async () => {
    const { phone } = await connect("grd-drain-1");
    await phone.waitForMarks(1);
    expect(lifecycle.liveCallCount()).toBe(1);

    const closeServer = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const shutdown = gracefulShutdown("SIGTERM", { drainTimeoutMs: 20_000, closeServer, closeDatabase });
    await new Promise((r) => setTimeout(r, 300));

    // New work is refused...
    expect(lifecycle.isDraining()).toBe(true);
    const refused = await http(cookie, "POST", "/api/calls", { agentId, callType: "outbound", toNumber: "+919000033333" });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ code: "SHUTTING_DOWN" });
    expect((await fetch(`${baseUrl}/ready`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    // ...but the live call was not cut off, and the process has not shut down underneath it.
    expect(phone.isOpen()).toBe(true);
    expect(closeServer).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();

    // The provider's status callbacks are still accepted while draining (the call must be able to finish cleanly).
    const callback = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: "unknown-during-drain", status: "completed" }),
    });
    expect(callback.status).toBe(200);

    // The customer hangs up normally: only now does shutdown complete.
    await phone.hangUp();
    const result = await shutdown;
    expect(result.forcedClosed).toBe(0);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("a call that outlasts the drain timeout is closed politely (1001), not dropped silently", async () => {
    const { phone } = await connect("grd-drain-2");
    await phone.waitForMarks(1);
    const result = await gracefulShutdown("SIGTERM", {
      drainTimeoutMs: 300,
      closeServer: async () => undefined,
      closeDatabase: async () => undefined,
    });
    expect(result.forcedClosed).toBe(1);
    expect((await phone.closed).code).toBe(1001);
  });
});
