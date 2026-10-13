/**
 * The existing real-estate booking call (Sales tools, scripted caller, mock providers, real Postgres) with BOTH
 * streaming STT and streaming LLM switched on. It must end exactly as the batch call does: same transcript, same tools
 * run once, same lead/site-visit outcome. Also checks the per-turn LLM metrics that the handler logs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.TURN_END_SILENCE_MS = "300";
process.env.REALTIME_STT_STREAMING = "true";
process.env.REALTIME_LLM_STREAMING = "true";

import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { leads } from "../db/schema.js";
import { MockTelephonyProvider } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { DEFAULT_CUSTOMER_TURNS, type SimulationReport } from "../simulator/call-simulator.js";
import { projectsService } from "../modules/projects/projects.service.js";
import { demoContext } from "../test/helpers.js";
import type { RequestContext } from "../auth/context.js";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let baseUrl: string;
let cookie = "";
let org: RequestContext;
const leadIds: string[] = [];
const turnLogs: Array<Record<string, unknown>> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { cookie, ...(init?.headers as Record<string, string> | undefined) } });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  org = await demoContext();
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const login = await fetch(`${baseUrl}/api/auth/demo-login`, { method: "POST" });
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  const real = console.log.bind(console);
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try {
      const o = JSON.parse(String(line));
      if (o.message === "turn: finished") turnLogs.push(o);
    } catch {
      // not a JSON log line
    }
    void real;
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  setTelephonyProvider(null);
  for (const id of leadIds) await db.delete(leads).where(eq(leads.id, id));
  await app.close();
});

describe("full Sales call with streaming STT + streaming LLM", () => {
  it("books the visit end to end exactly like the batch pipeline, with streamed turns and streaming metrics", async () => {
    const project = await projectsService.getDefaultProject(org);
    const [lead] = await db.insert(leads).values({ organizationId: org.organizationId, projectId: project.id, name: "Streaming E2E Lead", phone: "+919000000077" }).returning();
    leadIds.push(lead.id);

    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
    setTelephonyProvider(provider);
    const res = await api(`/api/leads/${lead.id}/call`, { method: "POST" });
    expect(res.status).toBe(202);
    const report = (await provider.simulations[0]) as SimulationReport;
    const callId = res.body.data.callId as string;
    expect(report.protocolViolations).toEqual([]);
    expect(report.aiAudioFrames).toBe(1 + DEFAULT_CUSTOMER_TURNS.length);
    for (let i = 0; i < 100; i++) {
      if ((await api(`/api/calls/${callId}`)).body.data.conversation?.summary) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const call = (await api(`/api/calls/${callId}`)).body.data;
    expect(call.status).toBe("completed");
    const transcript = call.conversation.transcript as Array<{ speaker: string; text: string }>;
    expect(transcript).toHaveLength(1 + 2 * DEFAULT_CUSTOMER_TURNS.length); // no duplicate or partial messages
    expect(transcript.filter((t) => t.speaker === "lead").map((t) => t.text)).toEqual([...DEFAULT_CUSTOMER_TURNS]);
    const aiTurns = transcript.filter((t) => t.speaker === "ai").map((t) => t.text);
    expect(aiTurns[3]).toContain("Saturday 11:30 AM");
    expect(aiTurns[4]).toContain("booked");
    expect(call.conversation.qualification).toMatchObject({ configuration: "2 BHK", siteVisitStatus: "booked", recommendedLeadStatus: "VISIT_BOOKED" });

    const l = (await api(`/api/leads/${lead.id}`)).body.data;
    expect(l.status).toBe("VISIT_BOOKED");
    expect(l.siteVisits).toHaveLength(1); // the booking tool ran exactly once
    expect(l.requirementConfig).toBe("2 BHK");

    // Streaming metrics: logged per turn, counts and timings only.
    const mine = turnLogs.filter((t) => t.callId === callId && t.kind === "user");
    expect(mine.length).toBe(DEFAULT_CUSTOMER_TURNS.length);
    for (const [i, t] of mine.entries()) {
      // The simulated caller hangs up as soon as it has heard the final reply, which ends that last turn mid-playback.
      if (i < mine.length - 1) expect(t.outcome).toBe("completed");
      else expect(["completed", "cancelled"]).toContain(t.outcome);
      expect(t.llmStreamed).toBe(true);
      expect(typeof t.sttFinalToLlmStartMs).toBe("number");
      expect(typeof t.llmMs).toBe("number");
      expect(JSON.stringify(t)).not.toContain("Green Valley"); // no transcript or reply text in metrics
    }
    const withText = mine.filter((t) => (t.llmChunks as number) > 0);
    expect(withText.length).toBeGreaterThan(0);
    for (const t of withText) {
      expect(typeof t.llmToFirstDeltaMs).toBe("number");
      expect(typeof t.llmFirstDeltaToFirstChunkMs).toBe("number");
    }
    const toolTurns = mine.filter((t) => (t.llmToolCalls as number) > 0);
    expect(toolTurns.length).toBeGreaterThan(0);
    for (const t of toolTurns) expect(t.llmHops as number).toBeGreaterThan(1); // tool result continued the generation
  });
});
