/**
 * The existing real-estate booking call (Sales tools, scripted caller, mock providers, real Postgres) with streaming
 * STT + streaming LLM + streaming TTS switched on. It must end exactly as the batch call does: same transcript, same
 * tools run once, same lead/site-visit outcome. REALTIME_TTS_STREAMING=false must leave the batch TTS path untouched.
 * Also checks the per-turn TTS metrics that the handler logs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.TURN_END_SILENCE_MS = "300";
process.env.REALTIME_STT_STREAMING = "true";
process.env.REALTIME_LLM_STREAMING = "true";
process.env.REALTIME_TTS_STREAMING = "true";

import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { leads } from "../db/schema.js";
import { MockTelephonyProvider } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { DEFAULT_CUSTOMER_TURNS, type SimulationReport } from "../simulator/call-simulator.js";
import { projectsService } from "../modules/projects/projects.service.js";
import { demoContext } from "../test/helpers.js";
import type { RequestContext } from "../auth/context.js";
import { setTtsProvider } from "../adapters/ai/index.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import { ReliableTextToSpeech } from "../adapters/ai/reliable-providers.js";

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
  setTtsProvider(null);
  for (const id of leadIds) await db.delete(leads).where(eq(leads.id, id));
  await app.close();
});

/** Places the standard scripted booking call and returns what the tests assert on. */
async function runCall(phone: string, tts: MockTtsProvider) {
  setTtsProvider(new ReliableTextToSpeech(tts));
  const project = await projectsService.getDefaultProject(org);
  const [lead] = await db.insert(leads).values({ organizationId: org.organizationId, projectId: project.id, name: "TTS Streaming E2E Lead", phone }).returning();
  leadIds.push(lead.id);
  const provider = new MockTelephonyProvider({ baseUrl, autoplay: true });
  setTelephonyProvider(provider);
  const res = await api(`/api/leads/${lead.id}/call`, { method: "POST" });
  expect(res.status).toBe(202);
  const report = (await provider.simulations[0]) as SimulationReport;
  const callId = res.body.data.callId as string;
  for (let i = 0; i < 100; i++) {
    if ((await api(`/api/calls/${callId}`)).body.data.conversation?.summary) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const call = (await api(`/api/calls/${callId}`)).body.data;
  const l = (await api(`/api/leads/${lead.id}`)).body.data;
  return { report, callId, call, lead: l };
}

describe("full Sales call with streaming STT + LLM + TTS", () => {
  it("books the visit exactly like the batch pipeline, speaking sentence by sentence, with TTS metrics", async () => {
    process.env.REALTIME_TTS_STREAMING = "true";
    const tts = new MockTtsProvider({ chunksPerSegment: 1, chunkBytes: 4000 });
    const { report, callId, call, lead } = await runCall("+919000000078", tts);

    expect(report.protocolViolations).toEqual([]); // every outbound frame is a legal Exotel frame (size, multiple of 320)
    expect(report.aiAudioFrames).toBeGreaterThanOrEqual(1 + DEFAULT_CUSTOMER_TURNS.length);
    expect(call.status).toBe("completed");
    const transcript = call.conversation.transcript as Array<{ speaker: string; text: string }>;
    expect(transcript).toHaveLength(1 + 2 * DEFAULT_CUSTOMER_TURNS.length); // no duplicate or partial messages
    expect(transcript.filter((t) => t.speaker === "lead").map((t) => t.text)).toEqual([...DEFAULT_CUSTOMER_TURNS]);
    expect(transcript.filter((t) => t.speaker === "ai").map((t) => t.text)[4]).toContain("booked");
    expect(call.conversation.qualification).toMatchObject({ siteVisitStatus: "booked", recommendedLeadStatus: "VISIT_BOOKED" });
    expect(lead.status).toBe("VISIT_BOOKED");
    expect(lead.siteVisits).toHaveLength(1); // the booking tool ran exactly once

    // The streaming path was used (and the batch path was not): one session per spoken reply, voice/language forwarded.
    expect(tts.streamSessions.length).toBeGreaterThanOrEqual(1 + DEFAULT_CUSTOMER_TURNS.length);
    expect(tts.requests).toEqual([]);
    for (const s of tts.streamSessions) expect(s.sampleRate).toBe(8000);
    expect(tts.streamSessions.every((s) => s.closed || s.cancelled)).toBe(true); // nothing left open

    const mine = turnLogs.filter((t) => t.callId === callId);
    const spoken = mine.filter((t) => t.ttsStreamed === true && (t.ttsSentences as number) > 0);
    expect(spoken.length).toBeGreaterThanOrEqual(DEFAULT_CUSTOMER_TURNS.length);
    for (const t of spoken) {
      expect(typeof t.ttsFirstAudioMs).toBe("number");
      expect(typeof t.ttsMs).toBe("number");
      expect(typeof t.ttsAudioMsToCaller).toBe("number");
      expect(JSON.stringify(t)).not.toContain("Green Valley"); // no reply text in metrics
    }
  });

  it("REALTIME_TTS_STREAMING=false keeps the existing batch TTS path (no streaming session is ever opened)", async () => {
    process.env.REALTIME_TTS_STREAMING = "false";
    const tts = new MockTtsProvider();
    const { report, callId, call } = await runCall("+919000000079", tts);
    expect(report.protocolViolations).toEqual([]);
    expect(report.aiAudioFrames).toBe(1 + DEFAULT_CUSTOMER_TURNS.length);
    expect(call.status).toBe("completed");
    expect(tts.streamSessions).toHaveLength(0);
    expect(tts.requests.length).toBeGreaterThanOrEqual(1 + DEFAULT_CUSTOMER_TURNS.length);
    const mine = turnLogs.filter((t) => t.callId === callId);
    expect(mine.some((t) => t.ttsStreamed === true)).toBe(false);
  });
});
