/**
 * The Voice AI core with the Sales module switched OFF, under the agent-first architecture: leadless agents keep
 * calling, lead features are refused, existing lead data stays visible, and in-flight lead calls still finalize.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.TURN_END_SILENCE_MS = "300";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db } from "../../db/client.js";
import { calls, leads, usageEvents } from "../../db/schema.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import { userContext } from "../../auth/context.js";
import { conversationsRepository } from "../../test/repos.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import {
  CapturingProvider,
  getCallRow,
  httpClient,
  randomPhone,
  relaxRateLimits,
  simulateExistingCall,
  startTestApp,
  waitForSummary,
} from "../../test/agent-first.js";
import { callsService } from "../calls/calls.service.js";
import { modulesService } from "./modules.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let D: TestTenant; // sales OFF from the start
let E: TestTenant; // sales on, switched off mid-call
let ownerD = "";
let agentRoleD = "";
let ownerE = "";
let genericD = "";

const NOT_ENABLED = /module is not enabled/i;

beforeAll(async () => {
  D = await createTenant("SD_D", { modules: [] });
  E = await createTenant("SD_E");
  const agentM = await createMember(D.orgId, "AGENT");
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  ownerD = await loginCookie(baseUrl, D.email);
  agentRoleD = await loginCookie(baseUrl, agentM.email);
  ownerE = await loginCookie(baseUrl, E.email);
  const g = await http(ownerD, "POST", "/api/agents", { name: "Support desk", personaName: "Sana", enabledTools: ["end_call"] });
  expect(g.status).toBe(201);
  genericD = g.body.data.id;
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants();
});

describe("leadless agent calls keep working with Sales off", () => {
  it("a test call (no number) runs end to end on the simulator, generic summary, listed and counted in usage", async () => {
    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    try {
      const res = await http(ownerD, "POST", "/api/calls", { agentId: genericD, callType: "test" });
      expect(res.status).toBe(202);
      const callId = res.body.data.callId as string;
      const report = await provider.simulations[0];
      expect(report?.protocolViolations).toEqual([]);
      const conv = await waitForSummary(D.orgId, callId);
      expect((conv.qualification as { profile?: string }).profile).toBe("generic");
      expect((conv.transcript as unknown[]).length).toBeGreaterThan(1);
      const row = await getCallRow(callId);
      expect(row).toMatchObject({ status: "completed", callType: "test", leadId: null, agentId: genericD, counterpartyNumber: null });

      const list = await http(ownerD, "GET", "/api/calls?callType=test");
      expect(list.body.data.map((c: { id: string }) => c.id)).toContain(callId);
      const usage = await db.select().from(usageEvents).where(eq(usageEvents.callId, callId));
      expect(usage.map((u) => u.type).sort()).toEqual(expect.arrayContaining(["ai_turn", "call"]));
      expect(usage.every((u) => u.organizationId === D.orgId)).toBe(true);
      expect(usage.every((u) => (u.metadata as { callType?: string }).callType === "test")).toBe(true);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("an outbound call by number runs to completion, is listed and counted in usage", async () => {
    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    try {
      const to = randomPhone();
      const res = await http(ownerD, "POST", "/api/calls", { agentId: genericD, callType: "outbound", toNumber: to });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ callType: "outbound", provider: "mock" });
      const callId = res.body.data.callId as string;
      await provider.simulations[0];
      await waitForSummary(D.orgId, callId);
      expect((await getCallRow(callId)).status).toBe("completed");

      const detail = await http(ownerD, "GET", `/api/calls/${callId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ callType: "outbound", counterpartyNumber: to, leadId: null, agent: { id: genericD, name: "Support desk", personaName: "Sana" } });

      const list = await http(ownerD, "GET", "/api/calls");
      expect(list.body.data.map((c: { id: string }) => c.id)).toContain(callId);
      const usage = await db.select().from(usageEvents).where(and(eq(usageEvents.callId, callId), eq(usageEvents.type, "call")));
      expect(usage).toHaveLength(1);
      const summary = await http(ownerD, "GET", "/api/usage/summary");
      expect(summary.status).toBe(200);
      expect(summary.body.data.totals.calls).toBeGreaterThanOrEqual(1);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("an AGENT-role user can also place a test call without the module", async () => {
    const res = await http(agentRoleD, "POST", "/api/calls", { agentId: genericD, callType: "test" });
    expect(res.status).toBe(202);
  });

  it("the default (sales-template) agent can run a leadless test call; it completes and is summarised", async () => {
    const call = await callsService.createCall(userContext(D.orgId, D.userId, "OWNER"), { agentId: D.agentId, callType: "test" });
    await simulateExistingCall(baseUrl, call);
    const conv = await conversationsRepository.findByCallId({ organizationId: D.orgId, callId: call.id });
    expect(conv?.summary).toBeTruthy();
    expect((await getCallRow(call.id)).status).toBe("completed");
  });
});

describe("lead features are refused with Sales off", () => {
  it("POST /api/leads/:id/call is 403 with a module message and creates nothing", async () => {
    const before = (await db.select().from(calls).where(eq(calls.organizationId, D.orgId))).length;
    const res = await http(ownerD, "POST", `/api/leads/${D.leadId}/call`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(NOT_ENABLED);
    expect((await db.select().from(calls).where(eq(calls.organizationId, D.orgId))).length).toBe(before);
  });

  it("POST /api/calls with a leadId is 403 with a module message, for both call types", async () => {
    const capture = new CapturingProvider();
    setTelephonyProvider(capture);
    try {
      const before = (await db.select().from(calls).where(eq(calls.organizationId, D.orgId))).length;
      for (const callType of ["outbound", "test"] as const) {
        const res = await http(ownerD, "POST", "/api/calls", { agentId: genericD, callType, leadId: D.leadId });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(NOT_ENABLED);
      }
      expect((await db.select().from(calls).where(eq(calls.organizationId, D.orgId))).length).toBe(before);
      expect(capture.calls).toHaveLength(0);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("creating a sales_real_estate agent is 403, and so is converting one to that template", async () => {
    const created = await http(ownerD, "POST", "/api/agents", { name: "Realtor", personaName: "Riya", promptTemplateKey: "sales_real_estate" });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(NOT_ENABLED);
    const converted = await http(ownerD, "PATCH", `/api/agents/${genericD}`, { promptTemplateKey: "sales_real_estate" });
    expect(converted.status).toBe(403);
    expect(converted.body.error).toMatch(NOT_ENABLED);
    const list = await http(ownerD, "GET", "/api/agents");
    expect(list.body.data.some((a: { name: string }) => a.name === "Realtor")).toBe(false);
  });

  it("the lead and project APIs themselves are gated too", async () => {
    expect((await http(ownerD, "GET", "/api/leads")).status).toBe(403);
    expect((await http(ownerD, "GET", `/api/leads/${D.leadId}`)).status).toBe(403);
  });
});

describe("older lead-based data is kept and still readable", () => {
  it("GET /api/calls still shows the lead-based call, with the lead's name", async () => {
    const res = await http(ownerD, "GET", "/api/calls");
    expect(res.status).toBe(200);
    const old = res.body.data.find((c: { id: string }) => c.id === D.callId);
    expect(old).toMatchObject({ id: D.callId, leadId: D.leadId, leadName: "SD_D Lead", status: "completed", summary: "summary of SD_D" });
  });

  it("the call detail still works, with its conversation and agent", async () => {
    const res = await http(ownerD, "GET", `/api/calls/${D.callId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: D.callId, leadId: D.leadId, agent: { id: D.agentId } });
    expect(res.body.data.conversation.summary).toBe("summary of SD_D");
    expect(res.body.data.conversation.transcript).toHaveLength(1);
  });

  it("the lead data is not deleted by switching the module off", async () => {
    expect(await db.select().from(leads).where(eq(leads.id, D.leadId))).toHaveLength(1);
  });
});

describe("an in-progress lead call survives the module being switched off", () => {
  it("still finalizes (system flows bypass the module gate) and updates the lead", async () => {
    // 1. Started while Sales was on: the lead is being dialed.
    const [lead] = await db.insert(leads).values({ organizationId: E.orgId, projectId: E.projectId, name: "In flight", phone: randomPhone() }).returning();
    const capture = new CapturingProvider();
    setTelephonyProvider(capture);
    let callId = "";
    try {
      const res = await http(ownerE, "POST", `/api/leads/${lead.id}/call`);
      expect(res.status).toBe(202);
      callId = res.body.data.callId;
    } finally {
      setTelephonyProvider(null);
    }
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("CALLING");

    // 2. The module is switched off while the call is still going.
    await modulesService.setEnabled(userContext(E.orgId, E.userId, "OWNER"), { moduleKey: "sales", enabled: false });
    expect((await http(ownerE, "GET", "/api/leads")).status).toBe(403);
    expect((await http(ownerE, "POST", `/api/leads/${lead.id}/call`)).status).toBe(403);

    // 3. The call carries on and ends: media stream + webhook + finalization all still work.
    const call = await getCallRow(callId);
    const report = await simulateExistingCall(baseUrl, call);
    expect(report.protocolViolations).toEqual([]);
    const done = await getCallRow(callId);
    expect(done.status).toBe("completed");
    expect(done.leadId).toBe(lead.id);

    const conv = await waitForSummary(E.orgId, callId);
    const q = conv.qualification as { profile?: string; recommendedLeadStatus?: string };
    expect(q.profile).not.toBe("generic");
    expect(q.recommendedLeadStatus).toBeTruthy();
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).not.toBe("CALLING");
    expect(after.status).toBe(q.recommendedLeadStatus);

    // The finished call remains listed.
    const list = await http(ownerE, "GET", "/api/calls");
    expect(list.body.data.find((c: { id: string }) => c.id === callId)).toMatchObject({ leadId: lead.id, status: "completed" });
  });

  it("an unanswered in-flight lead call still moves the lead out of CALLING", async () => {
    await modulesService.setEnabled(userContext(E.orgId, E.userId, "OWNER"), { moduleKey: "sales", enabled: true });
    const [lead] = await db.insert(leads).values({ organizationId: E.orgId, projectId: E.projectId, name: "No answer", phone: randomPhone() }).returning();
    setTelephonyProvider(new CapturingProvider());
    let callId = "";
    try {
      const res = await http(ownerE, "POST", `/api/leads/${lead.id}/call`);
      expect(res.status).toBe(202);
      callId = res.body.data.callId;
    } finally {
      setTelephonyProvider(null);
    }
    await modulesService.setEnabled(userContext(E.orgId, E.userId, "OWNER"), { moduleKey: "sales", enabled: false });
    await simulateExistingCall(baseUrl, await getCallRow(callId), { scenario: "no_answer" });
    expect((await getCallRow(callId)).status).toBe("failed");
    expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("NO_ANSWER");
  });
});

describe("module state", () => {
  it("Sales stays off for tenant D throughout", async () => {
    const mods = await http(ownerD, "GET", "/api/organization/modules");
    expect(mods.body.data).toEqual([expect.objectContaining({ key: "sales", enabled: false })]);
  });
});
