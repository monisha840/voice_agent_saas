/**
 * End-to-end tests for the media-stream WebSocket handler, driven by the
 * deterministic local call simulator over REAL HTTP + WebSocket against a
 * listening Fastify app and the real Postgres. Only external providers are
 * mocked (mock telephony/STT/LLM/TTS) — no Exotel/Sarvam credentials,
 * internet access or phone is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = ""; // baseline tests run open; the "securing" suite sets its own secret
process.env.TURN_END_SILENCE_MS = "300"; // keep end-of-turn detection fast in tests

import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { leads, usageEvents } from "../db/schema.js";
import { MockTelephonyProvider, type MockTelephonyOptions } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { DEFAULT_CUSTOMER_TURNS, type SimulationReport } from "../simulator/call-simulator.js";
import { projectsService } from "../modules/projects/projects.service.js";
import { callsService } from "../modules/calls/calls.service.js";
import { leadsRepository } from "../db/repositories/leads.repository.js";
import { auditRepository } from "../db/repositories/audit.repository.js";
import { demoContext } from "../test/helpers.js";
import type { RequestContext } from "../auth/context.js";

type App = Awaited<ReturnType<typeof buildApp>>;

interface TranscriptTurn {
  speaker: "ai" | "lead";
  text: string;
}

let app: App;
let baseUrl: string;
const createdLeadIds: string[] = [];
/** Session cookie of the seeded demo user (dev-only demo login). */
let sessionCookie = "";
let org: RequestContext;

async function createLead(): Promise<string> {
  const project = await projectsService.getDefaultProject(org);
  const [lead] = await db
    .insert(leads)
    .values({ organizationId: org.organizationId, projectId: project.id, name: "E2E Simulated Lead", phone: "+919000000001" })
    .returning();
  createdLeadIds.push(lead.id);
  return lead.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api<T = Record<string, any>>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(init?.headers as Record<string, string> | undefined) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Finalization runs in the background after the completed callback; wait for the summary to land. */
async function waitForFinalization(callId: string) {
  for (let i = 0; i < 100; i++) {
    const call = (await api(`/api/calls/${callId}`)).body.data;
    if (call.conversation?.summary) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`call ${callId} was never finalized`);
}

/** Clicks "Call Lead" through the real route and waits for the simulation to finish. */
async function placeSimulatedCall(leadId: string, options: MockTelephonyOptions = {}) {
  const provider = new MockTelephonyProvider({ baseUrl, autoplay: true, ...options });
  setTelephonyProvider(provider);
  const res = await api(`/api/leads/${leadId}/call`, { method: "POST" });
  expect(res.status).toBe(202);
  const report = (await provider.simulations[0]) as SimulationReport;
  expect(report).not.toBeNull();
  const callId = res.body.data.callId as string;
  if (report.scenario === "answered") await waitForFinalization(callId);
  return { callId, report };
}

beforeAll(async () => {
  org = await demoContext();
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const login = await fetch(`${baseUrl}/api/auth/demo-login`, { method: "POST" });
  expect(login.status).toBe(200);
  sessionCookie = login.headers.getSetCookie()[0].split(";")[0];
});

afterAll(async () => {
  setTelephonyProvider(null);
  for (const id of createdLeadIds) await db.delete(leads).where(eq(leads.id, id)); // cascades calls/conversations/visits
  await app.close();
});

describe("simulated call, end to end through the media-stream WebSocket handler", () => {
  it("POST /api/leads/:id/call -> WS conversation -> tools -> TTS -> completed -> finalized -> dashboard data", async () => {
    const leadId = await createLead();
    const { callId, report } = await placeSimulatedCall(leadId);

    // Simulator side: connected, 4 customer turns, AI audio for opening + each turn.
    const kinds = report.events.map((e) => e.kind);
    expect(kinds).toContain("ws_connected");
    expect(kinds).toContain("ws_start_sent");
    expect(report.customerTurnsSent).toEqual([...DEFAULT_CUSTOMER_TURNS]);
    expect(report.aiAudioFrames).toBe(1 + DEFAULT_CUSTOMER_TURNS.length);
    expect(report.protocolViolations).toEqual([]); // stream_sid on every frame, chunks >=3200 B and multiples of 320
    expect(report.events.filter((e) => e.kind === "status_callback").map((e) => e.detail)).toEqual([
      "ringing",
      "in_progress",
      "completed",
    ]);

    // Call: completed with timestamps.
    const call = (await api(`/api/calls/${callId}`)).body.data;
    expect(call.status).toBe("completed");
    expect(call.providerCallId).toBe(`mock-call-${callId}`);
    expect(call.startedAt).toBeTruthy();
    expect(call.endedAt).toBeTruthy();

    // Transcript: AI opening, then lead/AI pairs; scripted customer text went through STT verbatim.
    const transcript = call.conversation.transcript as TranscriptTurn[];
    expect(transcript).toHaveLength(1 + 2 * DEFAULT_CUSTOMER_TURNS.length);
    expect(transcript.filter((t) => t.speaker === "lead").map((t) => t.text)).toEqual([...DEFAULT_CUSTOMER_TURNS]);
    const aiTurns = transcript.filter((t) => t.speaker === "ai").map((t) => t.text);
    expect(aiTurns[3]).toContain("Saturday 11:30 AM"); // check_visit_slots result reached the model
    expect(aiTurns[4]).toContain("booked"); // book_site_visit result reached the model

    // Summary + qualification persisted.
    expect(call.conversation.summary).toContain("2 BHK");
    expect(call.conversation.qualification).toMatchObject({
      configuration: "2 BHK",
      budget: "INR 70 lakh",
      siteVisitStatus: "booked",
      recommendedLeadStatus: "VISIT_BOOKED",
    });

    // Lead updated by update_lead tool + finalization; site visit created by book_site_visit tool.
    const lead = (await api(`/api/leads/${leadId}`)).body.data;
    expect(lead.status).toBe("VISIT_BOOKED");
    expect(lead.requirementConfig).toBe("2 BHK");
    expect(lead.budgetMax).toBe(7_000_000);
    expect(lead.siteVisits).toHaveLength(1);
    expect(lead.siteVisits[0].status).toBe("booked");
    const visitAt = new Date(lead.siteVisits[0].scheduledAt);
    expect(visitAt.getDay()).toBe(6); // Saturday
    expect(visitAt.getHours()).toBe(11);
    expect(visitAt.getMinutes()).toBe(30);

    // Dashboard APIs return the updated data.
    expect(lead.callHistory[0].id).toBe(callId);
    expect(lead.latestConversation.summary).toBe(call.conversation.summary);
    const list = (await api("/api/leads")).body.data as Array<{ id: string; status: string }>;
    expect(list.find((l) => l.id === leadId)?.status).toBe("VISIT_BOOKED");
  });

  it("is idempotent: duplicate completed callbacks and repeated finalizeCall create no duplicates", async () => {
    const leadId = await createLead();
    const { callId } = await placeSimulatedCall(leadId, { duplicateCompletedCallback: true });

    const before = (await api(`/api/calls/${callId}`)).body.data;

    // A third completed callback, straight at the webhook, as a provider retry would.
    await api("/api/telephony/exotel/status-callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: before.providerCallId, status: "completed", durationSeconds: 99 }),
    });
    // A late, out-of-order "ringing" must not regress the finished call.
    await api("/api/telephony/exotel/status-callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: before.providerCallId, status: "ringing" }),
    });

    const after = (await api(`/api/calls/${callId}`)).body.data;
    expect(after.status).toBe("completed");
    expect(after.endedAt).toBe(before.endedAt);
    expect(after.conversation.summary).toBe(before.conversation.summary);
    expect(after.conversation.transcript).toEqual(before.conversation.transcript);

    const lead = (await api(`/api/leads/${leadId}`)).body.data;
    expect(lead.siteVisits).toHaveLength(1);
    expect(lead.status).toBe("VISIT_BOOKED");

    // Direct re-finalization must not regenerate or re-apply lead status.
    await leadsRepository.updateStatus({ organizationId: org.organizationId, id: leadId, status: "FOLLOW_UP" });
    await callsService.finalizeCall(org, { callId });
    expect((await leadsRepository.findById({ organizationId: org.organizationId, id: leadId }))?.status).toBe("FOLLOW_UP");
    expect((await api(`/api/calls/${callId}`)).body.data.conversation.summary).toBe(before.conversation.summary);
  });

  it.each([
    ["busy", "BUSY"],
    ["no_answer", "NO_ANSWER"],
  ] as const)("%s call is distinguished on the lead (not blindly FAILED) and is never finalized", async (scenario, leadStatus) => {
    const leadId = await createLead();
    const { callId, report } = await placeSimulatedCall(leadId, { scenario });

    expect(report.events.some((e) => e.kind === "ws_connected")).toBe(false);
    const call = (await api(`/api/calls/${callId}`)).body.data;
    expect(call.status).toBe("failed"); // calls table has no finer enum; the outcome lives on the lead
    expect(call.conversation.summary).toBeNull();
    expect((await api(`/api/leads/${leadId}`)).body.data.status).toBe(leadStatus);
  });
});

describe("audit and usage for a full simulated call", () => {
  it("records call.initiated, site_visit.booked and exactly one site_visit usage event, with no phone numbers", async () => {
    const leadId = await createLead();
    const { callId } = await placeSimulatedCall(leadId);

    const initiated = await auditRepository.list({ organizationId: org.organizationId, limit: 10, action: "call.initiated", entityId: callId });
    expect(initiated).toHaveLength(1);
    expect(initiated[0].metadata).toMatchObject({ callId, leadId, provider: "mock" });

    const lead = (await api(`/api/leads/${leadId}`)).body.data;
    expect(lead.siteVisits).toHaveLength(1);
    const visitId = lead.siteVisits[0].id as string;
    const booked = await auditRepository.list({ organizationId: org.organizationId, limit: 10, action: "site_visit.booked", entityId: visitId });
    expect(booked).toHaveLength(1);
    expect(booked[0].metadata).toMatchObject({ leadId, projectId: lead.projectId });
    expect(booked[0].actorType).toBe("system");

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.dedupeKey, `site_visit:${visitId}`));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ type: "site_visit", quantity: 1, organizationId: org.organizationId });

    expect(JSON.stringify([initiated[0], booked[0]])).not.toContain("9000000001");
  });
});

describe("customer phone number validation", () => {
  it("rejects an invalid number with 422 INVALID_PHONE before creating any call", async () => {
    const project = await projectsService.getDefaultProject(org);
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: org.organizationId, projectId: project.id, name: "Bad Phone Lead", phone: "12345" })
      .returning();
    createdLeadIds.push(lead.id);
    const res = await api(`/api/leads/${lead.id}/call`, { method: "POST" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_PHONE");
    const detail = (await api(`/api/leads/${lead.id}`)).body.data;
    expect(detail.callHistory).toHaveLength(0);
    expect(detail.status).toBe("NEW");
  });
});

describe("call resolution without the query string", () => {
  it("resolves the call from start.call_sid when Exotel does not pass internalCallId through", async () => {
    const leadId = await createLead();
    const { callId, report } = await placeSimulatedCall(leadId, { passInternalCallIdInUrl: false });
    expect(report.protocolViolations).toEqual([]);
    const call = (await api(`/api/calls/${callId}`)).body.data;
    expect(call.status).toBe("completed");
    expect((call.conversation.transcript as TranscriptTurn[]).length).toBe(1 + 2 * DEFAULT_CUSTOMER_TURNS.length);
  });
});

describe("securing the public endpoints", () => {
  const SECRET = "test-secret-not-real";
  const wsBase = () => baseUrl.replace(/^http/, "ws");
  const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET;
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET;
    else process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = previous;
  });

  it("rejects an unauthenticated WebSocket with 1008 and an unauthenticated status callback with 401", async () => {
    const ws = new WebSocket(`${wsBase()}/api/telephony/exotel/media-stream?internalCallId=x`);
    expect(await closeCode(ws)).toBe(1008);

    const wrong = new WebSocket(`${wsBase()}/api/telephony/exotel/media-stream?token=wrong`);
    expect(await closeCode(wrong)).toBe(1008);

    const res = await api("/api/telephony/exotel/status-callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ CallSid: "x", Status: "completed" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts the secret as ?token= or as a Basic-auth password", async () => {
    const viaToken = await fetch(`${baseUrl}/api/telephony/exotel/status-callback?token=${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId: "unknown", status: "completed" }),
    });
    expect(viaToken.status).toBe(200);
    const basic = Buffer.from(`exotel:${SECRET}`).toString("base64");
    const viaBasic = await fetch(`${baseUrl}/api/telephony/exotel/status-callback`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
      body: JSON.stringify({ providerCallId: "unknown", status: "completed" }),
    });
    expect(viaBasic.status).toBe(200);
  });

  it("a full simulated call still completes when the secret is enforced (simulator authenticates)", async () => {
    const leadId = await createLead();
    const { callId, report } = await placeSimulatedCall(leadId);
    expect(report.protocolViolations).toEqual([]);
    expect((await api(`/api/calls/${callId}`)).body.data.status).toBe("completed");
  });

  it("only /health and the Exotel endpoints are reachable through a tunnel; lead/call/project APIs are hidden", async () => {
    const viaTunnel = { "x-forwarded-for": "203.0.113.9" };
    expect((await fetch(`${baseUrl}/health`, { headers: viaTunnel })).status).toBe(200);
    for (const path of ["/api/leads", "/api/projects", "/api/calls/00000000-0000-0000-0000-000000000000"]) {
      expect((await fetch(`${baseUrl}${path}`, { headers: viaTunnel })).status).toBe(404);
    }
    // Same endpoints stay available locally (the dashboard).
    expect((await fetch(`${baseUrl}/api/leads`, { headers: { cookie: sessionCookie } })).status).toBe(200);
  });
});

describe("media-stream WebSocket handler protocol edge cases", () => {
  const wsBase = () => baseUrl.replace(/^http/, "ws");
  const closed = (ws: WebSocket) => new Promise<void>((resolve) => ws.once("close", () => resolve()));

  it("ignores non-JSON frames, tolerates connected/dtmf, and closes when start references an unknown call", async () => {
    const ws = new WebSocket(`${wsBase()}/api/telephony/exotel/media-stream?internalCallId=00000000-0000-0000-0000-000000000000`);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send("not json");
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(JSON.stringify({ event: "dtmf", stream_sid: "x", dtmf: { digit: "5" } }));
    ws.send(JSON.stringify({ event: "start", stream_sid: "x", start: { stream_sid: "x", call_sid: "nope" } }));
    await closed(ws);
  });
});
