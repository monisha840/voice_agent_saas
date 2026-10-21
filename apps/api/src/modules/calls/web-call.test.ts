/**
 * Browser web call, end to end over real HTTP + WebSocket + Postgres (mock STT/LLM/TTS). The "browser" here speaks
 * what the web page speaks: connected / start / media / mark / stop. Checks the happy path through the SAME pipeline a
 * phone call uses, and that the channel is private: login required, the caller's own call only, single use, allowed
 * origins only, and unreachable through a tunnel.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";
process.env.TURN_END_SILENCE_MS = "300";
process.env.WEB_CALL_ENABLED = "true"; // the channel is off by default

import { encodeMockSpeech } from "../../adapters/ai/mock.stt.provider.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { getCallRow, relaxRateLimits, startTestApp, waitForSummary } from "../../test/agent-first.js";

relaxRateLimits();

const ORIGIN = "http://127.0.0.1:3000";
let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl: string;
let A: TestTenant;
let cookie = "";
let otherCookie = "";

async function createWebCall(c = cookie) {
  const res = await fetch(`${baseUrl}/api/calls/web`, { method: "POST", headers: { cookie: c } });
  return { status: res.status, body: (await res.json()) as { data?: { callId: string; sampleRate: number }; error?: string } };
}

/** Connects like the page does. Resolves to the socket and what it heard; `closed` carries the close code. */
function openBrowser(callId: string, opts: { cookie?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  const c = opts.cookie ?? cookie;
  if (c) headers.cookie = c;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/web-call/stream?callId=${callId}`, { headers });
  const heard = { media: 0, marks: [] as string[] };
  ws.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const opened = new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", () => resolve(false));
    ws.once("unexpected-response", () => resolve(false));
  });
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString()) as { event?: string; mark?: { name?: string } };
    if (f.event === "media") heard.media++;
    if (f.event === "mark" && f.mark?.name) {
      heard.marks.push(f.mark.name);
      ws.send(JSON.stringify({ event: "mark", stream_sid: "web-1", mark: { name: f.mark.name } })); // "finished playing"
    }
  });
  return { ws, heard, closed, opened };
}

function startFrames(ws: WebSocket, callId: string) {
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(
    JSON.stringify({
      event: "start",
      stream_sid: "web-1",
      start: { stream_sid: "web-1", call_sid: `web-${callId}`, media_format: { encoding: "pcm_s16le", sample_rate: "8000", bit_rate: "128kbps" } },
    }),
  );
}

async function until(cond: () => boolean, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  A = await createTenant("web-call-a");
  const other = await createMember(A.orgId, "ADMIN", "web-call-other");
  ({ app, baseUrl } = await startTestApp());
  cookie = await loginCookie(baseUrl, A.email);
  otherCookie = await loginCookie(baseUrl, other.email);
});

afterAll(async () => {
  await app.close();
  await cleanupTenants();
});

describe("browser web call", () => {
  it("runs a full conversation from a microphone-style stream, then ends and is summarized", async () => {
    const created = await createWebCall();
    expect(created.status).toBe(201);
    const callId = created.body.data!.callId;
    expect(created.body.data!.sampleRate).toBe(8000);

    const b = openBrowser(callId);
    expect(await b.opened).toBe(true);
    startFrames(b.ws, callId);
    await until(() => b.heard.marks.length >= 1, "the agent's opening line"); // the agent greets first
    expect(b.heard.media).toBeGreaterThan(0);

    // The caller speaks (loud frames), then is quiet long enough for the turn to end.
    const speech = encodeMockSpeech("What is the price of a 2 BHK?");
    for (let i = 0; i < speech.length; i += 1600) {
      b.ws.send(JSON.stringify({ event: "media", stream_sid: "web-1", media: { payload: speech.subarray(i, i + 1600).toString("base64") } }));
    }
    for (let i = 0; i < 8; i++) {
      b.ws.send(JSON.stringify({ event: "media", stream_sid: "web-1", media: { payload: Buffer.alloc(1600).toString("base64") } }));
    }
    await until(() => b.heard.marks.length >= 2, "the agent's reply");

    b.ws.send(JSON.stringify({ event: "stop", stream_sid: "web-1", stop: { reason: "hangup" } }));
    b.ws.close();
    await b.closed;
    await waitForSummary(A.orgId, callId);
    const row = await getCallRow(callId);
    expect(row.status).toBe("completed");
    expect(row.callType).toBe("test");
    expect(row.providerCallId).toBeNull(); // no telephony provider was involved
  }, 40_000);

  it("requires a login, for both creating the call and opening the stream", async () => {
    expect((await fetch(`${baseUrl}/api/calls/web`, { method: "POST" })).status).toBe(401);
    const { body } = await createWebCall();
    const b = openBrowser(body.data!.callId, { cookie: "" });
    expect(await b.opened).toBe(false);
  });

  it("refuses another user's call, a foreign origin, and a second use", async () => {
    const { body } = await createWebCall();
    const callId = body.data!.callId;

    const stranger = openBrowser(callId, { cookie: otherCookie }); // same organization, different user
    await stranger.opened;
    expect(await stranger.closed).toBe(1008);

    const foreign = openBrowser(callId, { origin: "https://evil.example" });
    await foreign.opened;
    expect(await foreign.closed).toBe(1008);

    const first = openBrowser(callId);
    expect(await first.opened).toBe(true);
    const second = openBrowser(callId);
    await second.opened;
    expect(await second.closed).toBe(1008);
    first.ws.close();
    await first.closed;
  });

  it("can be started as one of the organization's leads, and refuses a lead it cannot see", async () => {
    const res = await fetch(`${baseUrl}/api/calls/web`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leadId: A.leadId }),
    });
    expect(res.status).toBe(201);
    const callId = ((await res.json()) as { data: { callId: string } }).data.callId;
    expect((await getCallRow(callId)).leadId).toBe(A.leadId);

    const missing = await fetch(`${baseUrl}/api/calls/web`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leadId: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(missing.status).toBe(404);
  });

  it("refuses an unknown call id", async () => {
    const b = openBrowser("00000000-0000-4000-8000-000000000000");
    await b.opened;
    expect(await b.closed).toBe(1008);
  });

  it("is not reachable through a tunnel", async () => {
    const tunnel = { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "x.example.test" };
    const res = await fetch(`${baseUrl}/api/calls/web`, { method: "POST", headers: { cookie, ...tunnel } });
    expect(res.status).toBe(404);
    const { body } = await createWebCall();
    const b = openBrowser(body.data!.callId, { headers: tunnel });
    expect(await b.opened).toBe(false);
  });
});
