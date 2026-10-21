/**
 * Barge-in end to end: the caller talks over the agent's opening line (REALTIME_BARGE_IN=true, streaming STT + LLM + TTS,
 * slow mock TTS so the greeting is still being spoken). Through the real WebSocket handler, real Postgres and the Sales
 * tools. What must hold: Exotel is told to flush buffered audio, nothing of the interrupted greeting is "played"
 * (its playback mark never appears), the caller's words get a reply, the call still ends exactly like an uninterrupted
 * one, and the interrupted turn is logged as interrupted.
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
process.env.REALTIME_BARGE_IN = "true";
// This scenario uses a very short mock greeting, so the caller must be able to interrupt after 300 ms of speech. The
// production default is 600 ms so that short noises (a cough, a click) do not cut the agent off.
process.env.REALTIME_BARGE_IN_MIN_SPEECH_MS = "300";

import { buildApp } from "../app.js";
import { adminDb as db } from "../db/client.js";
import { leads } from "../db/schema.js";
import { MockTelephonyProvider } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import { DEFAULT_CUSTOMER_TURNS, type SimulationReport } from "../simulator/call-simulator.js";
import { projectsService } from "../modules/projects/projects.service.js";
import { demoContext } from "../test/helpers.js";
import { setTtsProvider } from "../adapters/ai/index.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import { ReliableTextToSpeech } from "../adapters/ai/reliable-providers.js";
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
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try {
      const o = JSON.parse(String(line));
      if (o.message === "turn: finished") turnLogs.push(o);
    } catch {
      // not a JSON log line
    }
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  setTelephonyProvider(null);
  setTtsProvider(null);
  for (const id of leadIds) await db.delete(leads).where(eq(leads.id, id));
  await app.close();
});

describe("barge-in over the agent's opening line", () => {
  it("flushes Exotel's buffer, never plays the interrupted greeting, answers the caller and books the visit as usual", async () => {
    // Slow TTS: the greeting takes seconds to produce, so the caller is certainly talking over it.
    const tts = new MockTtsProvider({ chunksPerSegment: 10, chunkBytes: 3200, chunkDelayMs: 15 });
    setTtsProvider(new ReliableTextToSpeech(tts));
    const project = await projectsService.getDefaultProject(org);
    const [lead] = await db.insert(leads).values({ organizationId: org.organizationId, projectId: project.id, name: "Barge-in E2E Lead", phone: "+919000000081" }).returning();
    leadIds.push(lead.id);

    const provider = new MockTelephonyProvider({ baseUrl, autoplay: true, interruptOpening: true });
    setTelephonyProvider(provider);
    const res = await api(`/api/leads/${lead.id}/call`, { method: "POST" });
    expect(res.status).toBe(202);
    const report = (await provider.simulations[0]) as SimulationReport;
    const callId = res.body.data.callId as string;
    for (let i = 0; i < 100; i++) {
      if ((await api(`/api/calls/${callId}`)).body.data.conversation?.summary) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(report.protocolViolations).toEqual([]);
    expect(report.clearFrames).toBeGreaterThanOrEqual(1); // Exotel was told to flush what it had buffered
    // One playback mark per caller turn and none for the greeting: it was cut off, so its mark was never even queued.
    expect(report.marks).toHaveLength(DEFAULT_CUSTOMER_TURNS.length);

    // Turn history: the greeting turn is logged as interrupted; the caller's turns were answered normally.
    const mine = turnLogs.filter((t) => t.callId === callId);
    const greeting = mine.find((t) => t.kind === "ai");
    expect(greeting).toMatchObject({ outcome: "interrupted", interrupted: true });
    expect(mine.filter((t) => t.kind === "user").every((t) => t.outcome === "completed" || t.outcome === "cancelled")).toBe(true);

    // The conversation continued exactly as an uninterrupted call would have.
    const call = (await api(`/api/calls/${callId}`)).body.data;
    expect(call.status).toBe("completed");
    const transcript = call.conversation.transcript as Array<{ speaker: string; text: string }>;
    expect(transcript.filter((t) => t.speaker === "lead").map((t) => t.text)).toEqual([...DEFAULT_CUSTOMER_TURNS]);
    const l = (await api(`/api/leads/${lead.id}`)).body.data;
    expect(l.status).toBe("VISIT_BOOKED");
    expect(l.siteVisits).toHaveLength(1); // the booking tool ran exactly once
    expect(tts.streamSessions.every((s) => s.closed || s.cancelled)).toBe(true); // no provider session left open
    expect(tts.streamSessions[0].cancelled).toBe(true); // the greeting's TTS session was cancelled, not left to finish
  }, 30_000);
});
