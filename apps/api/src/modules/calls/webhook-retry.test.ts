/**
 * Provider status-callback error handling. The contract: a payload we can never understand gets 200 (retrying cannot
 * help); an internal failure (database down) gets 500 so the provider retries, and the retry then lands exactly once.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { db } from "../../db/client.js";
import { calls, usageEvents } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import type { ITelephonyProvider } from "../../adapters/telephony/telephony.interface.js";
import { ProviderRequestError } from "../../shared/errors.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../test/tenants.js";
import { getCallRow, relaxRateLimits, startTestApp, waitForSummary } from "../../test/agent-first.js";
import { callsService } from "./calls.service.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let agentId = "";

beforeAll(async () => {
  A = await createTenant("WHR_A");
  ({ app, baseUrl } = await startTestApp());
  agentId = (
    await createDefaultAgent(A.orgId, { name: "Webhook agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
  ).id;
});
afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});
afterEach(() => {
  vi.restoreAllMocks();
  setTelephonyProvider(null);
  delete process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET;
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
});

async function newAnsweredCall() {
  const providerCallId = `whr-${Math.random().toString(36).slice(2, 10)}`;
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000099999" });
  await callsService.attachProviderCallId(systemContext(A.orgId, "test"), { callId: call.id, providerCallId });
  return { call, providerCallId };
}

const post = (body: unknown, query = "") =>
  fetch(`${baseUrl}/api/telephony/exotel/status-callback${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const usageCount = async (callId: string) => (await db.select().from(usageEvents).where(eq(usageEvents.callId, callId))).length;

/** Finalization stores the summary first and writes usage after it, so wait until the usage count stops changing. */
async function settledUsageCount(callId: string) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 100 && stable < 4; i++) {
    const n = await usageCount(callId);
    stable = n === last ? stable + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe("status-callback error handling", () => {
  it("an internal failure answers 500 so the provider retries; the retry then applies exactly once", async () => {
    const { call, providerCallId } = await newAnsweredCall();
    const real = callsService.applyProviderStatus.bind(callsService);
    const spy = vi.spyOn(callsService, "applyProviderStatus").mockRejectedValueOnce(new Error("database is down"));

    // Delivery 1: the database is down. Nothing changes, and the provider is told to try again.
    const first = await post({ providerCallId, status: "completed", durationSeconds: 30 });
    expect(first.status).toBe(500);
    const body = (await first.json()) as { error: string; requestId: string };
    expect(body.error).toBe("Internal server error");
    expect(body.requestId).toBe(first.headers.get("x-request-id"));
    expect((await getCallRow(call.id)).status).not.toBe("completed");

    // Delivery 2 (the provider's retry): the database is back.
    spy.mockImplementation(real);
    const second = await post({ providerCallId, status: "completed", durationSeconds: 30 });
    expect(second.status).toBe(200);
    expect((await getCallRow(call.id)).status).toBe("completed");
    await waitForSummary(A.orgId, call.id);
    const usageAfterRetry = await settledUsageCount(call.id);
    expect(usageAfterRetry).toBeGreaterThan(0);

    // Delivery 3 (a duplicate retry): accepted, and changes nothing: usage idempotency is unchanged.
    const third = await post({ providerCallId, status: "completed", durationSeconds: 30 });
    expect(third.status).toBe(200);
    expect(await settledUsageCount(call.id)).toBe(usageAfterRetry);
  });

  it("a payload the provider adapter cannot parse is 200 {ok:false}: retrying would never help", async () => {
    const unparseable: ITelephonyProvider = {
      name: "strict",
      initiateCall: async () => {
        throw new Error("unused");
      },
      parseStatusCallback: () => {
        throw new ProviderRequestError("strict", "Unrecognized call status");
      },
    };
    setTelephonyProvider(unparseable);
    const applySpy = vi.spyOn(callsService, "applyProviderStatus");
    const res = await post({ whatever: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("a callback for a call we do not know is 200 and creates nothing", async () => {
    setTelephonyProvider(new MockTelephonyProvider({ autoplay: false }));
    const before = (await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length;
    const res = await post({ providerCallId: "never-heard-of-it", status: "completed" });
    expect(res.status).toBe(200);
    expect((await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).length).toBe(before);
  });

  it("an unauthorized callback is 401 and applies nothing", async () => {
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "a-long-random-webhook-secret-123";
    const { call, providerCallId } = await newAnsweredCall();
    const res = await post({ providerCallId, status: "completed" });
    expect(res.status).toBe(401);
    const authorized = await post({ providerCallId, status: "ringing" }, "?token=a-long-random-webhook-secret-123");
    expect(authorized.status).toBe(200);
    expect((await getCallRow(call.id)).status).toBe("ringing");
  });

  it("a failing post-call finalization does not turn the callback into an error (the call is already closed)", async () => {
    const { call, providerCallId } = await newAnsweredCall();
    vi.spyOn(callsService, "finalizeCall").mockRejectedValue(new Error("summary model unavailable"));
    const res = await post({ providerCallId, status: "completed" });
    expect(res.status).toBe(200);
    expect((await getCallRow(call.id)).status).toBe("completed");
    const [row] = await db.select().from(calls).where(and(eq(calls.id, call.id), eq(calls.organizationId, A.orgId)));
    expect(row.endedAt).toBeTruthy();
  });
});
