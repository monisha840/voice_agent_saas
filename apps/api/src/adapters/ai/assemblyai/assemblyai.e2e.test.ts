/**
 * EXPERIMENT — the whole Exotel media-stream handler with AssemblyAI explicitly selected: caller PCM in, a local
 * AssemblyAI-protocol server for STT, the existing mock LLM + TTS, real Postgres for the transcript. Also the
 * "selected but unconfigured" case, which must refuse the call rather than fall back to another provider.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";

import { systemContext } from "../../../auth/context.js";
import { setTelephonyProvider } from "../../telephony/index.js";
import { setSttProvider } from "../index.js";
import { encodeMockSpeech } from "../mock.stt.provider.js";
import { conversationsRepository } from "../../../db/repositories/conversations.repository.js";
import { lifecycle } from "../../../runtime/lifecycle.js";
import { cleanupTenants, createDefaultAgent, createTenant, type TestTenant } from "../../../test/tenants.js";
import { relaxRateLimits, startTestApp } from "../../../test/agent-first.js";
import { openPhone, type PhoneSocket } from "../../../test/phone-socket.js";
import { callsService } from "../../../modules/calls/calls.service.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
relaxRateLimits();

const MARKER = Buffer.from("MOCKSPEECH1:", "utf8");
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let agentId = "";
let wss: WebSocketServer;
let aaiUrl = "";
let aaiConnections = 0;
const phones: PhoneSocket[] = [];

/** A tiny AssemblyAI-protocol server: on ForceEndpoint it "transcribes" the scripted speech carried in the audio it received. */
async function startFakeAssemblyAi() {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  aaiUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v3/ws`;
  let turnOrder = 0;
  wss.on("connection", (ws, req) => {
    aaiConnections++;
    const model = new URL(req.url!, "ws://x").searchParams.get("speech_model");
    let audio: Buffer[] = [];
    ws.send(JSON.stringify({ type: "Begin", id: "s", expires_at: 1, configuration: { model } }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return void audio.push(Buffer.from(d as Buffer));
      const m = JSON.parse(d.toString());
      if (m.type === "Terminate") ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 1 }));
      if (m.type !== "ForceEndpoint") return;
      const all = Buffer.concat(audio);
      audio = [];
      const start = all.indexOf(MARKER);
      const text = start < 0 ? "" : all.toString("utf8", start + MARKER.length, all.indexOf(0, start + MARKER.length)).trim();
      const base = { type: "Turn", turn_order: turnOrder, transcript: text, utterance: text, end_of_turn_confidence: 1, words: [] };
      ws.send(JSON.stringify({ ...base, end_of_turn: false, turn_is_formatted: false, transcript: text.split(" ")[0] ?? "" }));
      ws.send(JSON.stringify({ ...base, end_of_turn: true, turn_is_formatted: false }));
      ws.send(JSON.stringify({ ...base, end_of_turn: true, turn_is_formatted: true })); // format_turns: the formatted twin
      turnOrder++;
    });
  });
}

async function connect(callSid: string) {
  const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId, callType: "outbound", counterpartyNumber: "+919000088888" });
  const phone = await openPhone(baseUrl, { callSid, internalCallId: call.id });
  phones.push(phone);
  return { call, phone };
}
const mediaEvent = (payload: string) => JSON.stringify({ event: "media", stream_sid: "s", media: { payload } });
function say(phone: PhoneSocket, text: string) {
  const speech = encodeMockSpeech(text);
  for (let i = 0; i < speech.length; i += 1600) phone.ws.send(mediaEvent(speech.subarray(i, i + 1600).toString("base64")));
  for (let i = 0; i < 6; i++) phone.ws.send(mediaEvent(Buffer.alloc(1600).toString("base64")));
}
async function leadTurns(callId: string): Promise<string[]> {
  const c = await conversationsRepository.findByCallId({ organizationId: A.orgId, callId });
  return ((c?.transcript ?? []) as Array<{ speaker: string; text: string }>).filter((t) => t.speaker === "lead").map((t) => t.text);
}
const ENV = ["REALTIME_STT_PROVIDER", "REALTIME_STT_STREAMING", "ASSEMBLYAI_API_KEY", "ASSEMBLYAI_STT_URL"];
function selectAssemblyAi(key = "aai-e2e-key") {
  process.env.REALTIME_STT_PROVIDER = "assemblyai";
  process.env.REALTIME_STT_STREAMING = "true";
  process.env.ASSEMBLYAI_API_KEY = key;
  process.env.ASSEMBLYAI_STT_URL = aaiUrl;
  setSttProvider(null);
}

beforeAll(async () => {
  await startFakeAssemblyAi();
  A = await createTenant("AAI_A");
  agentId = (await createDefaultAgent(A.orgId, { name: "AAI agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {} })).id;
  ({ app, baseUrl } = await startTestApp());
});
afterAll(async () => {
  setSttProvider(null);
  setTelephonyProvider(null);
  await app.close();
  await new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r())));
  await cleanupTenants();
});
afterEach(async () => {
  for (const p of phones.splice(0)) if (p.isOpen()) await p.hangUp();
  for (const k of ENV) delete process.env[k];
  setSttProvider(null);
  lifecycle.reset();
  process.env.SILENCE_TIMEOUT_MS = "0";
  process.env.MAX_CALL_DURATION_MS = "0";
});

describe("AssemblyAI selected end to end", () => {
  it("transcribes through the AssemblyAI protocol and stores exactly one lead message per utterance (the formatted twin does not duplicate it)", async () => {
    selectAssemblyAi();
    const before = aaiConnections;
    const { call, phone } = await connect("aai-e2e-1");
    await phone.waitForMarks(1);
    say(phone, "Can you tell me the price and location of the project?");
    await phone.waitForMarks(2);
    say(phone, "Hello, I am looking for a two bedroom apartment.");
    await phone.waitForMarks(3);
    await new Promise((r) => setTimeout(r, 300)); // room for a wrong extra reply to show up
    expect(phone.marks.length).toBe(3);
    expect(await leadTurns(call.id)).toEqual(["Can you tell me the price and location of the project?", "Hello, I am looking for a two bedroom apartment."]);
    expect(aaiConnections - before).toBe(1); // one session for the whole call
  });

  it("hanging up closes the AssemblyAI session and releases the call", async () => {
    selectAssemblyAi();
    const { phone } = await connect("aai-e2e-2");
    await phone.waitForMarks(1);
    say(phone, "I was saying something and then");
    await new Promise((r) => setTimeout(r, 100));
    await phone.hangUp();
    await new Promise((r) => setTimeout(r, 200));
    expect(lifecycle.liveCallCount()).toBe(0);
  });

  it("selected without a key, the call is refused with 1011; it does NOT fall back to another STT provider", async () => {
    selectAssemblyAi("");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = aaiConnections;
    const { phone } = await connect("aai-e2e-3");
    const closed = await phone.closed;
    expect(closed.code).toBe(1011);
    expect(phone.marks.length).toBe(0); // the agent never spoke
    expect(aaiConnections).toBe(before);
    vi.restoreAllMocks();
  });

  it("a Tamil agent on AssemblyAI is refused clearly: no transcript, no fake support, the call stays up", async () => {
    selectAssemblyAi();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { agentId: tamilAgent } = await (async () => {
      const a = await createDefaultAgent(A.orgId, { name: "Tamil agent", promptTemplateKey: "generic", enabledTools: ["end_call"], isDefault: false, moduleConfig: {}, language: "ta-IN" });
      return { agentId: a.id };
    })();
    const call = await callsService.createCall(systemContext(A.orgId, "test"), { agentId: tamilAgent, callType: "outbound", counterpartyNumber: "+919000088889" });
    const phone = await openPhone(baseUrl, { callSid: "aai-e2e-ta", internalCallId: call.id });
    phones.push(phone);
    await phone.waitForMarks(1);
    say(phone, "இந்த project-ல இரண்டு BHK விலை எவ்வளவு?");
    await new Promise((r) => setTimeout(r, 600));
    expect(phone.marks.length).toBe(1); // only the greeting: the turn failed with a clear config error, nothing was invented
    expect(await leadTurns(call.id)).toEqual([]);
    vi.restoreAllMocks();
  });
});
