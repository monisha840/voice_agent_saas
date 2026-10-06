/**
 * The agent-first call model end to end: Organization -> Agent -> Call -> optional Lead.
 * Leadless outbound calls, test calls, the legacy lead-based outbound path, and inbound routing by dialed number,
 * all against the real Postgres and (where a call is run) the local call simulator over real HTTP + WebSocket.
 * Only external providers are mocked; no Exotel/Sarvam credentials are needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.TURN_END_SILENCE_MS = "300";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false"; // only explicit providers in this file run simulations

import { db } from "../../db/client.js";
import { agentKnowledgeBindings, agentPhoneNumbers, calls, leads, projects } from "../../db/schema.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import { systemContext } from "../../auth/context.js";
import { NotFoundError } from "../../shared/errors.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import {
  CapturingProvider,
  ForbiddenProvider,
  getCallRow,
  httpClient,
  randomPhone,
  relaxRateLimits,
  simulateExistingCall,
  startTestApp,
  waitForSummary,
} from "../../test/agent-first.js";
import { callsService } from "./calls.service.js";
import { agentPhoneNumbersService } from "../agents/agent-phone-numbers.service.js";
import { agentsService } from "../agents/agents.service.js";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let http: ReturnType<typeof httpClient>;
let A: TestTenant; // sales on
let B: TestTenant; // sales on, another organization
let C: TestTenant; // sales off
let owner = "";
let admin = "";
let manager = "";
let agentRole = "";
let agentRoleUserId = "";
let adminB = "";
let genericAgentId = "";
let ctxA: ReturnType<typeof systemContext>;

const phoneRow = async (callId: string) => (await db.select().from(calls).where(eq(calls.id, callId)))[0];

beforeAll(async () => {
  A = await createTenant("AFC_A");
  B = await createTenant("AFC_B");
  C = await createTenant("AFC_C", { modules: [] });
  ctxA = systemContext(A.orgId, "test");
  const adminM = await createMember(A.orgId, "ADMIN");
  const managerM = await createMember(A.orgId, "MANAGER");
  const agentM = await createMember(A.orgId, "AGENT");
  const adminBM = await createMember(B.orgId, "ADMIN");
  agentRoleUserId = agentM.userId;
  ({ app, baseUrl } = await startTestApp());
  http = httpClient(baseUrl);
  owner = await loginCookie(baseUrl, A.email);
  admin = await loginCookie(baseUrl, adminM.email);
  manager = await loginCookie(baseUrl, managerM.email);
  agentRole = await loginCookie(baseUrl, agentM.email);
  adminB = await loginCookie(baseUrl, adminBM.email);
  const generic = await createDefaultAgent(A.orgId, {
    name: "Generic outbound",
    personaName: "Gita",
    promptTemplateKey: "generic",
    enabledTools: ["end_call"],
    isDefault: false,
    moduleConfig: {},
  });
  genericAgentId = generic.id;
});

afterAll(async () => {
  setTelephonyProvider(null);
  await app.close();
  await cleanupTenants(); // calls first, then agents (bindings and phone numbers cascade)
});

describe("leadless outbound calls", () => {
  let leadlessCallId = "";
  let ownCallId = "";
  const number = randomPhone();

  it("a call with no lead is created for a generic agent and has lead_id null", async () => {
    const call = await callsService.createCall(ctxA, { agentId: genericAgentId, callType: "outbound", counterpartyNumber: number });
    leadlessCallId = call.id;
    const row = await phoneRow(call.id);
    expect(row).toMatchObject({
      organizationId: A.orgId,
      agentId: genericAgentId,
      leadId: null,
      callType: "outbound",
      counterpartyNumber: number,
      counterpartyName: null,
      status: "initiating",
      initiatedByUserId: null,
    });
    expect(await conversationsRepository.findByCallId({ organizationId: A.orgId, callId: call.id })).not.toBeNull();
  });

  it("appears in GET /api/calls for owner, admin and manager (leadless calls are visible to managers)", async () => {
    for (const cookie of [owner, admin, manager]) {
      const res = await http(cookie, "GET", "/api/calls");
      expect(res.status).toBe(200);
      const row = res.body.data.find((c: { id: string }) => c.id === leadlessCallId);
      expect(row).toMatchObject({
        id: leadlessCallId,
        agentId: genericAgentId,
        agentName: "Generic outbound",
        callType: "outbound",
        leadId: null,
        leadName: null,
        counterpartyNumber: number,
      });
    }
  });

  it("an AGENT-role user does not see it, but sees the calls they initiated themselves", async () => {
    const before = await http(agentRole, "GET", "/api/calls");
    expect(before.status).toBe(200);
    expect(before.body.data.map((c: { id: string }) => c.id)).not.toContain(leadlessCallId);
    expect((await http(agentRole, "GET", `/api/calls/${leadlessCallId}`)).status).toBe(404);

    const placed = await http(agentRole, "POST", "/api/calls", { agentId: genericAgentId, callType: "test" });
    expect(placed.status).toBe(202);
    ownCallId = placed.body.data.callId;
    expect((await phoneRow(ownCallId)).initiatedByUserId).toBe(agentRoleUserId);

    const after = await http(agentRole, "GET", "/api/calls");
    const ids = after.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(ownCallId);
    expect(ids).not.toContain(leadlessCallId);
    expect(ids).not.toContain(A.callId); // a lead call on a lead that is not assigned to them
    expect((await http(agentRole, "GET", `/api/calls/${ownCallId}`)).status).toBe(200);
  });

  it("the detail endpoint returns the agent, call type and counterparty", async () => {
    const res = await http(owner, "GET", `/api/calls/${leadlessCallId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: leadlessCallId,
      callType: "outbound",
      counterpartyNumber: number,
      leadId: null,
      agent: { id: genericAgentId, name: "Generic outbound", personaName: "Gita" },
    });
    expect(Object.keys(res.body.data.agent).sort()).toEqual(["id", "name", "personaName"]);
    expect(res.body.data.conversation).toBeTruthy();
  });

  it("filters by agentId and callType", async () => {
    const byAgent = await http(owner, "GET", `/api/calls?agentId=${genericAgentId}`);
    expect(byAgent.body.data.map((c: { id: string }) => c.id)).toContain(leadlessCallId);
    expect(byAgent.body.data.every((c: { agentId: string }) => c.agentId === genericAgentId)).toBe(true);
    const tests = await http(owner, "GET", "/api/calls?callType=test");
    expect(tests.body.data.map((c: { id: string }) => c.id)).toContain(ownCallId);
    expect(tests.body.data.map((c: { id: string }) => c.id)).not.toContain(leadlessCallId);
  });

  it("runs through the simulator end to end: completed, transcript stored, GENERIC summary, no lead touched", async () => {
    // A lead that must stay untouched by a leadless call.
    const phone = randomPhone();
    const [bystander] = await db
      .insert(leads)
      .values({ organizationId: A.orgId, projectId: A.projectId, name: "Bystander", phone })
      .returning();

    const call = await callsService.createCall(ctxA, { agentId: genericAgentId, callType: "outbound", counterpartyNumber: phone });
    const report = await simulateExistingCall(baseUrl, call);
    expect(report.protocolViolations).toEqual([]);
    expect(report.scenario).toBe("answered");

    const done = await getCallRow(call.id);
    expect(done.status).toBe("completed");
    expect(done.leadId).toBeNull();
    expect(done.startedAt).toBeTruthy();
    expect(done.endedAt).toBeTruthy();

    const detail = await http(owner, "GET", `/api/calls/${call.id}`);
    const conv = detail.body.data.conversation;
    expect(conv.transcript.length).toBeGreaterThan(1);
    expect(conv.transcript.some((t: { speaker: string }) => t.speaker === "ai")).toBe(true);
    expect(conv.transcript.some((t: { speaker: string }) => t.speaker === "lead")).toBe(true);
    expect(conv.summary).toBeTruthy();
    expect(conv.qualification.profile).toBe("generic");
    expect(conv.qualification).not.toHaveProperty("recommendedLeadStatus");

    const [untouched] = await db.select().from(leads).where(eq(leads.id, bystander.id));
    expect(untouched.status).toBe("NEW");
    expect(untouched.requirementConfig).toBeNull();
    expect(untouched.updatedAt.getTime()).toBe(bystander.updatedAt.getTime());
  });
});

describe("test calls and POST /api/calls", () => {
  it("a test call without a number is a simulation on the mock provider even when another provider is configured", async () => {
    const forbidden = new ForbiddenProvider();
    setTelephonyProvider(forbidden);
    try {
      const res = await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "test" });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ callType: "test", provider: "mock" });
      expect(forbidden.used).toBe(0);
      const row = await phoneRow(res.body.data.callId);
      expect(row).toMatchObject({ callType: "test", counterpartyNumber: null, leadId: null, agentId: genericAgentId });
      expect(row.providerCallId).toBe(res.body.data.providerCallId);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("a test call with a number uses the configured provider and stores the number", async () => {
    const capture = new CapturingProvider("capture");
    setTelephonyProvider(capture);
    try {
      const res = await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "test", toNumber: "9876543210" });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ callType: "test", provider: "capture" });
      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0].toNumber).toBe("+919876543210");
      expect(capture.calls[0].internalCallId).toBe(res.body.data.callId);
      expect((await phoneRow(res.body.data.callId)).counterpartyNumber).toBe("+919876543210");
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("an outbound call to a number goes through the configured provider", async () => {
    const capture = new CapturingProvider("capture");
    setTelephonyProvider(capture);
    try {
      const to = randomPhone();
      const res = await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "outbound", toNumber: to });
      expect(res.status).toBe(202);
      expect(res.body.data).toMatchObject({ callType: "outbound", provider: "capture" });
      expect(capture.calls.map((c) => c.toNumber)).toEqual([to]);
      expect(await phoneRow(res.body.data.callId)).toMatchObject({ callType: "outbound", leadId: null, counterpartyNumber: to });
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("a test call over HTTP runs to completion on the simulator", async () => {
    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    try {
      const res = await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "test" });
      expect(res.status).toBe(202);
      await provider.simulations[0];
      await waitForSummary(A.orgId, res.body.data.callId);
      const row = await phoneRow(res.body.data.callId);
      expect(row.status).toBe("completed");
      expect(row.callType).toBe("test");
      expect(row.counterpartyNumber).toBeNull();
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("outbound without a number or a lead is a 400 and creates nothing", async () => {
    const before = await db.select().from(calls).where(eq(calls.organizationId, A.orgId));
    const res = await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "outbound" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone number or a lead/i);
    expect(await db.select().from(calls).where(eq(calls.organizationId, A.orgId))).toHaveLength(before.length);
  });

  it("rejects invalid input: bad uuid / inbound type / unknown field = 400", async () => {
    expect((await http(owner, "POST", "/api/calls", { agentId: "nope", callType: "test" })).status).toBe(400);
    expect((await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "inbound" })).status).toBe(400);
    expect((await http(owner, "POST", "/api/calls", { agentId: genericAgentId, callType: "test", extra: 1 })).status).toBe(400);
  });

  it("an unknown, archived or foreign agent is a 404", async () => {
    const unknown = await http(owner, "POST", "/api/calls", { agentId: "11111111-1111-4111-8111-111111111111", callType: "test" });
    expect(unknown.status).toBe(404);

    const archivedAgent = await createDefaultAgent(A.orgId, { name: "Soon archived", isDefault: false, promptTemplateKey: "generic", enabledTools: ["end_call"], moduleConfig: {} });
    await agentsService.archive(ctxA, archivedAgent.id);
    expect((await http(owner, "POST", "/api/calls", { agentId: archivedAgent.id, callType: "test" })).status).toBe(404);

    expect((await http(owner, "POST", "/api/calls", { agentId: B.agentId, callType: "test" })).status).toBe(404);
  });

  it("AGENT-role users can place calls (calls:create)", async () => {
    const capture = new CapturingProvider("capture");
    setTelephonyProvider(capture);
    try {
      const res = await http(agentRole, "POST", "/api/calls", { agentId: genericAgentId, callType: "outbound", toNumber: randomPhone() });
      expect(res.status).toBe(202);
      expect((await phoneRow(res.body.data.callId)).initiatedByUserId).toBe(agentRoleUserId);
    } finally {
      setTelephonyProvider(null);
    }
  });
});

describe("lead-based outbound (legacy flow) through the agent model", () => {
  let projectBoundAgentId = "";
  let boundProjectId = "";
  let boundLeadId = "";

  beforeAll(async () => {
    const [project] = await db.insert(projects).values({ organizationId: A.orgId, name: "Bound Towers", location: "Somewhere" }).returning();
    boundProjectId = project.id;
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: A.orgId, projectId: project.id, name: "Bound Lead", phone: randomPhone() })
      .returning();
    boundLeadId = lead.id;
    const agent = await createDefaultAgent(A.orgId, { name: "Bound project agent", personaName: "Rohan", isDefault: false });
    projectBoundAgentId = agent.id;
    await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId: agent.id, sourceType: "project", sourceId: project.id });
  });

  async function callLead(leadId: string, body?: unknown) {
    const capture = new CapturingProvider("capture");
    setTelephonyProvider(capture);
    try {
      const res = await http(owner, "POST", `/api/leads/${leadId}/call`, body);
      return { res, capture };
    } finally {
      setTelephonyProvider(null);
    }
  }

  it("uses the agent bound to the lead's project and copies the lead's phone and name to the counterparty", async () => {
    const { res, capture } = await callLead(boundLeadId);
    expect(res.status).toBe(202);
    const row = await phoneRow(res.body.data.callId);
    const [lead] = await db.select().from(leads).where(eq(leads.id, boundLeadId));
    expect(row).toMatchObject({
      agentId: projectBoundAgentId,
      leadId: boundLeadId,
      callType: "outbound",
      counterpartyNumber: lead.phone,
      counterpartyName: "Bound Lead",
      initiatedByUserId: A.userId,
    });
    expect(capture.calls[0].toNumber).toBe(lead.phone);
    expect(lead.status).toBe("CALLING");
  });

  it("falls back to the organization default agent when the project has no bound agent", async () => {
    const { res } = await callLead(A.leadId);
    expect(res.status).toBe(202);
    const row = await phoneRow(res.body.data.callId);
    expect(row.agentId).toBe(A.agentId);
    expect(row.leadId).toBe(A.leadId);
    expect(row.counterpartyName).toBe("AFC_A Lead");
  });

  it("an explicit agentId in the body overrides the project's agent", async () => {
    const { res } = await callLead(boundLeadId, { agentId: genericAgentId });
    expect(res.status).toBe(202);
    expect((await phoneRow(res.body.data.callId)).agentId).toBe(genericAgentId);
    expect((await callLead(boundLeadId, { agentId: A.agentId })).res.status).toBe(202);
  });

  it("an archived project agent is skipped (default is used)", async () => {
    const [p] = await db.insert(projects).values({ organizationId: A.orgId, name: "Skip Towers", location: "x" }).returning();
    const [l] = await db.insert(leads).values({ organizationId: A.orgId, projectId: p.id, name: "Skip Lead", phone: randomPhone() }).returning();
    const a = await createDefaultAgent(A.orgId, { name: "Archived bound", isDefault: false });
    await db.insert(agentKnowledgeBindings).values({ organizationId: A.orgId, agentId: a.id, sourceType: "project", sourceId: p.id });
    await agentsService.archive(ctxA, a.id);
    const { res } = await callLead(l.id);
    expect(res.status).toBe(202);
    expect((await phoneRow(res.body.data.callId)).agentId).toBe(A.agentId);
  });

  it("a lead call via POST /api/calls {leadId} uses the same rules when the agent is given", async () => {
    const capture = new CapturingProvider("capture");
    setTelephonyProvider(capture);
    try {
      const res = await http(owner, "POST", "/api/calls", { agentId: projectBoundAgentId, callType: "outbound", leadId: boundLeadId });
      expect(res.status).toBe(202);
      const row = await phoneRow(res.body.data.callId);
      expect(row).toMatchObject({ leadId: boundLeadId, agentId: projectBoundAgentId, counterpartyName: "Bound Lead" });
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("the lead status flow still completes with the sales summary profile", async () => {
    const phone = randomPhone();
    const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Flow Lead", phone }).returning();
    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    try {
      const res = await http(owner, "POST", `/api/leads/${lead.id}/call`);
      expect(res.status).toBe(202);
      expect(res.body.data.provider).toBe("mock");
      const callId = res.body.data.callId as string;
      expect((await db.select().from(leads).where(eq(leads.id, lead.id)))[0].status).toBe("CALLING");
      const report = await provider.simulations[0];
      expect(report?.protocolViolations).toEqual([]);
      const conv = await waitForSummary(A.orgId, callId);
      const q = conv.qualification as { recommendedLeadStatus?: string; profile?: string };
      expect(q.profile).not.toBe("generic");
      expect(q.recommendedLeadStatus).toBeTruthy();
      const row = await phoneRow(callId);
      expect(row.status).toBe("completed");
      expect(row.agentId).toBe(A.agentId);
      const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
      expect(after.status).not.toBe("CALLING");
      expect(after.status).toBe(q.recommendedLeadStatus);
    } finally {
      setTelephonyProvider(null);
    }
  });

  it("keeps a project binding in place", async () => {
    const rows = await db
      .select()
      .from(agentKnowledgeBindings)
      .where(and(eq(agentKnowledgeBindings.organizationId, A.orgId), eq(agentKnowledgeBindings.sourceId, boundProjectId)));
    expect(rows).toHaveLength(1);
  });
});

describe("inbound calls", () => {
  let inboundAgentId = "";
  let archivedAgentId = "";
  let dialed = "";
  let dialedC = "";
  let dialedB = "";
  let inboundAgentC = "";

  beforeAll(async () => {
    const agent = await createDefaultAgent(A.orgId, {
      name: "Inbound desk",
      personaName: "Ira",
      promptTemplateKey: "generic",
      enabledTools: ["end_call"],
      isDefault: false,
      moduleConfig: {},
    });
    inboundAgentId = agent.id;
    dialed = randomPhone();
  });

  it("only ADMIN and above can add a phone number to an agent; managers and agents get 403", async () => {
    const body = { phoneNumber: dialed, label: "Main line" };
    expect((await http(manager, "POST", `/api/agents/${inboundAgentId}/phone-numbers`, body)).status).toBe(403);
    expect((await http(agentRole, "POST", `/api/agents/${inboundAgentId}/phone-numbers`, body)).status).toBe(403);
    const added = await http(admin, "POST", `/api/agents/${inboundAgentId}/phone-numbers`, body);
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ agentId: inboundAgentId, organizationId: A.orgId, phoneNumber: dialed, label: "Main line" });
    const list = await http(admin, "GET", `/api/agents/${inboundAgentId}/phone-numbers`);
    expect(list.body.data.map((r: { phoneNumber: string }) => r.phoneNumber)).toEqual([dialed]);
  });

  it("a duplicate number is a 409, within and across organizations", async () => {
    expect((await http(admin, "POST", `/api/agents/${genericAgentId}/phone-numbers`, { phoneNumber: dialed })).status).toBe(409);
    expect((await http(owner, "POST", `/api/agents/${inboundAgentId}/phone-numbers`, { phoneNumber: dialed })).status).toBe(409);
    const cross = await http(adminB, "POST", `/api/agents/${B.agentId}/phone-numbers`, { phoneNumber: dialed });
    expect(cross.status).toBe(409);
    expect(await db.select().from(agentPhoneNumbers).where(eq(agentPhoneNumbers.phoneNumber, dialed))).toHaveLength(1);
  });

  it("routes an inbound call to the number's agent and organization, ringing, counterparty = caller", async () => {
    const caller = randomPhone();
    const call = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: caller });
    expect(call).toMatchObject({
      organizationId: A.orgId,
      agentId: inboundAgentId,
      callType: "inbound",
      status: "ringing",
      counterpartyNumber: caller,
      leadId: null, // unknown caller
      initiatedByUserId: null,
    });
    expect(await conversationsRepository.findByCallId({ organizationId: A.orgId, callId: call.id })).not.toBeNull();
    // A different spelling of the dialed number reaches the same agent.
    const again = await callsService.startInboundCall({ dialedNumber: dialed.replace("+91", "0"), callerNumber: randomPhone() });
    expect(again.agentId).toBe(inboundAgentId);
  });

  it("attaches a lead only when exactly one lead in that organization has the caller's number (Sales on)", async () => {
    const match = randomPhone();
    const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Caller Lead", phone: match }).returning();
    const matched = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: match });
    expect(matched.leadId).toBe(lead.id);
    expect(matched.counterpartyNumber).toBe(match);

    const none = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: randomPhone() });
    expect(none.leadId).toBeNull();

    const twice = randomPhone();
    await db.insert(leads).values([
      { organizationId: A.orgId, projectId: A.projectId, name: "Twin 1", phone: twice },
      { organizationId: A.orgId, projectId: A.projectId, name: "Twin 2", phone: twice },
    ]);
    const ambiguous = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: twice });
    expect(ambiguous.leadId).toBeNull();

    const anonymous = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: null });
    expect(anonymous.leadId).toBeNull();
    expect(anonymous.counterpartyNumber).toBeNull();
  });

  it("does not attach a lead when the Sales module is disabled", async () => {
    inboundAgentC = (
      await createDefaultAgent(C.orgId, { name: "C inbound", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })
    ).id;
    dialedC = randomPhone();
    await agentPhoneNumbersService.add(systemContext(C.orgId, "test"), { agentId: inboundAgentC, phoneNumber: dialedC });
    const phone = randomPhone();
    await db.insert(leads).values({ organizationId: C.orgId, projectId: C.projectId, name: "C Lead", phone });
    const call = await callsService.startInboundCall({ dialedNumber: dialedC, callerNumber: phone });
    expect(call).toMatchObject({ organizationId: C.orgId, agentId: inboundAgentC, callType: "inbound", leadId: null, counterpartyNumber: phone });
  });

  it("an unknown dialed number is a NotFoundError and creates nothing", async () => {
    const before = (await db.select({ id: calls.id }).from(calls)).length;
    await expect(callsService.startInboundCall({ dialedNumber: randomPhone(), callerNumber: randomPhone() })).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.select({ id: calls.id }).from(calls)).length).toBe(before);
  });

  it("an archived agent refuses the call and nothing is created", async () => {
    const archived = await createDefaultAgent(A.orgId, { name: "Archived inbound", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} });
    archivedAgentId = archived.id;
    const number = randomPhone();
    await agentPhoneNumbersService.add(ctxA, { agentId: archived.id, phoneNumber: number });
    await agentsService.archive(ctxA, archived.id);
    const before = (await db.select().from(calls).where(eq(calls.agentId, archivedAgentId))).length;
    await expect(callsService.startInboundCall({ dialedNumber: number, callerNumber: randomPhone() })).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.select().from(calls).where(eq(calls.agentId, archivedAgentId))).length).toBe(before);
  });

  it("cross-tenant: a caller number matching org A's lead never attaches that lead to org B's call", async () => {
    const shared = randomPhone();
    const [leadA] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "A only", phone: shared }).returning();
    dialedB = randomPhone();
    await agentPhoneNumbersService.add(systemContext(B.orgId, "test"), { agentId: B.agentId, phoneNumber: dialedB });
    const call = await callsService.startInboundCall({ dialedNumber: dialedB, callerNumber: shared });
    expect(call.organizationId).toBe(B.orgId);
    expect(call.agentId).toBe(B.agentId);
    expect(call.leadId).toBeNull();
    expect(call.leadId).not.toBe(leadA.id);
    // and the reverse: a call to A's number from B's lead's number
    const bPhone = randomPhone();
    await db.insert(leads).values({ organizationId: B.orgId, projectId: B.projectId, name: "B only", phone: bPhone });
    const callBLead = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: bPhone });
    expect(callBLead.organizationId).toBe(A.orgId);
    expect(callBLead.leadId).toBeNull();
  });

  it("an inbound call runs through the simulator and completes with the generic summary", async () => {
    const call = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: randomPhone() });
    const report = await simulateExistingCall(baseUrl, call);
    expect(report.protocolViolations).toEqual([]);
    const row = await getCallRow(call.id);
    expect(row.status).toBe("completed");
    expect(row.callType).toBe("inbound");
    const conv = await conversationsRepository.findByCallId({ organizationId: A.orgId, callId: call.id });
    expect((conv!.transcript as unknown[]).length).toBeGreaterThan(1);
    expect((conv!.qualification as { profile?: string }).profile).toBe("generic");
  });

  it("an inbound call from a known lead completes without changing a generic agent's lead", async () => {
    const phone = randomPhone();
    const [lead] = await db.insert(leads).values({ organizationId: A.orgId, projectId: A.projectId, name: "Known caller", phone }).returning();
    const call = await callsService.startInboundCall({ dialedNumber: dialed, callerNumber: phone });
    expect(call.leadId).toBe(lead.id);
    await simulateExistingCall(baseUrl, call);
    expect((await getCallRow(call.id)).status).toBe("completed");
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after.status).toBe("NEW"); // generic summary has no recommended lead status
  });
});
