/**
 * Real recordings (apps/api/bench-audio, 8 kHz PCM) played as the caller through the simulator, over the real
 * WebSocket handler, with and without line impairments (background noise, lost frames). The mock STT cannot read the
 * words, so this proves what it can: the turn detector cuts each recording into exactly one caller turn, the agent
 * answers every one, the audio the server sends back still satisfies Exotel's framing rules, and the call completes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.TURN_END_SILENCE_MS = "400";

import { buildApp } from "../app.js";
import { MockTelephonyProvider, type MockTelephonyOptions } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import type { SimulationReport } from "../simulator/call-simulator.js";
import { parseWav } from "../audio/pcm.js";
import { demoContext } from "../test/helpers.js";
import { defaultAgentIdFor } from "../test/tenants.js";

const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bench-audio");
const RECORDINGS = ["english.wav", "tamil.wav", "tamil-pure.wav"].map((f) => {
  const wav = parseWav(readFileSync(path.join(BENCH_DIR, f)));
  if (!wav || wav.sampleRate !== 8000) throw new Error(`${f} is not an 8 kHz PCM wav`);
  return wav.pcm;
});

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let baseUrl: string;
let cookie = "";
let agentId = "";
const turnLogs: Array<Record<string, unknown>> = [];

async function placeCall(options: MockTelephonyOptions) {
  const provider = new MockTelephonyProvider({ baseUrl, autoplay: true, ...options });
  setTelephonyProvider(provider);
  turnLogs.length = 0;
  const res = await fetch(`${baseUrl}/api/calls`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId, callType: "test" }),
  });
  expect(res.status).toBe(202);
  const report = (await provider.simulations[0]) as SimulationReport;
  expect(report).not.toBeNull();
  await new Promise((r) => setTimeout(r, 300)); // let the last turn log land
  return report;
}

beforeAll(async () => {
  const org = await demoContext();
  agentId = await defaultAgentIdFor(org.organizationId);
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
      // not a structured line
    }
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  setTelephonyProvider(null);
  await app.close();
});

function expectOneTurnPerRecording(report: SimulationReport) {
  expect(report.protocolViolations).toEqual([]);
  expect(report.customerTurnsSent).toHaveLength(RECORDINGS.length);
  expect(report.aiAudioFrames).toBe(RECORDINGS.length + 1); // the opening line plus one reply per recording
  expect(turnLogs.filter((t) => t.kind === "user")).toHaveLength(RECORDINGS.length);
  expect(report.events.map((e) => e.kind)).toContain("ws_closed");
  expect(report.events.at(-1)).toEqual({ kind: "status_callback", detail: "completed" });
}

describe("real recordings as the caller", () => {
  it("clean line: one caller turn per recording, each answered", async () => {
    expectOneTurnPerRecording(await placeCall({ customerAudio: RECORDINGS }));
  }, 60_000);

  it("noisy line: background noise does not split or merge the turns", async () => {
    expectOneTurnPerRecording(await placeCall({ customerAudio: RECORDINGS, impairments: { noiseAmplitude: 300 } }));
  }, 60_000);

  it("lossy line: every 10th frame lost, the call still completes with each recording answered", async () => {
    expectOneTurnPerRecording(await placeCall({ customerAudio: RECORDINGS, impairments: { dropEveryNthFrame: 10 } }));
  }, 60_000);
});
