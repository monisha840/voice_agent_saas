/**
 * Pre-flight for the Exotel Voicebot applet, run against the REAL public URL.
 *
 * Plays the part of Exotel's applet the way it will connect on a real inbound call: a wss:// connection to
 * EXOTEL_WEBHOOK_BASE_URL with ?token=<secret> (the same URL `pnpm exotel:flow-url` prints), then the documented
 * connected / start (with `to` = the dialed ExoPhone) / media / mark / stop events. It proves, from outside this
 * machine's loopback: the tunnel or server is reachable over TLS, the token is enforced, the dialed number routes to an
 * agent, the agent greets, replies come back in valid chunks, the call is recorded and completed, and the dashboard API
 * is NOT exposed on that address.
 *
 * It borrows ONE throwaway phone number for the demo organization's default agent for the duration of the run and
 * removes it afterwards. It places no real call and talks to no telephony provider.
 *
 * Usage:  pnpm --filter @voice-agent/api exotel:preflight
 * Needs:  the API running locally (pnpm dev:api), the tunnel up, EXOTEL_WEBHOOK_BASE_URL (https) and
 *         EXOTEL_AGENTSTREAM_WEBHOOK_SECRET set, and a seeded database.
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import WebSocket from "ws";
import { getConfig } from "../config/env.js";
import { sql } from "../db/client.js";
import { agentPhoneNumbersRepository } from "../db/repositories/agent-phone-numbers.repository.js";
import { agentsRepository } from "../db/repositories/agents.repository.js";
import { callsRepository } from "../db/repositories/calls.repository.js";
import { organizationsRepository } from "../db/repositories/organizations.repository.js";
import { encodeMockSpeech } from "../adapters/ai/mock.stt.provider.js";

const FAKE_NUMBER = "+919000000099";
const FRAME = 1600;

const cfg = getConfig().exotel;
const base = cfg.webhookBaseUrl.replace(/\/+$/, "");
const secret = cfg.agentStreamWebhookSecret;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function wsUrl(token?: string) {
  const u = base.replace(/^https/i, "wss");
  return `${u}/api/telephony/exotel/media-stream${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;
}

/** Opens a socket and reports whether it stayed open or was closed by the server (and with which code). */
function probe(url: string, waitMs = 2500): Promise<{ opened: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    let opened = false;
    ws.on("open", () => {
      opened = true;
      setTimeout(() => {
        ws.close();
        resolve({ opened: true });
      }, waitMs);
    });
    ws.on("close", (code) => resolve({ opened, closeCode: code }));
    ws.on("error", () => resolve({ opened }));
  });
}

async function main() {
  if (!/^https:\/\//i.test(base) || !secret) {
    console.error("Set EXOTEL_WEBHOOK_BASE_URL (https://…) and EXOTEL_AGENTSTREAM_WEBHOOK_SECRET in .env first.");
    process.exit(2);
  }
  console.log(`Target: ${base.replace(/^https/i, "wss")}/api/telephony/exotel/media-stream?token=<hidden>\n`);

  // 1. Reachable and healthy through the public address.
  try {
    const res = await fetch(`${base}/health`, { headers: { "ngrok-skip-browser-warning": "1" } });
    record("public /health reachable over TLS", res.ok, `HTTP ${res.status}`);
  } catch (err) {
    record("public /health reachable over TLS", false, err instanceof Error ? err.message : String(err));
    return finish();
  }

  // 2. The dashboard API must not be exposed on the public address.
  const dash = await fetch(`${base}/api/calls`, { headers: { "ngrok-skip-browser-warning": "1" } });
  record("dashboard API is NOT served on the public address", dash.status === 404, `HTTP ${dash.status}`);

  // 3. Token is enforced.
  const noToken = await probe(wsUrl());
  record("stream without a token is refused", !noToken.opened || noToken.closeCode === 1008, `close ${noToken.closeCode ?? "refused"}`);
  const badToken = await probe(wsUrl("not-the-secret-not-the-secret"));
  record("stream with a wrong token is refused", !badToken.opened || badToken.closeCode === 1008, `close ${badToken.closeCode ?? "refused"}`);

  // 4. A full inbound call through the correct URL, routed by the dialed number.
  const org = await organizationsRepository.findBySlug({ slug: "demo" });
  const agent = org ? await agentsRepository.findDefault({ organizationId: org.id }) : null;
  if (!org || !agent) {
    record("demo organization has a default agent", false, "run pnpm db:seed");
    return finish();
  }
  const existing = await agentPhoneNumbersRepository.findByNumberAnyOrg({ phoneNumber: FAKE_NUMBER });
  if (existing) await agentPhoneNumbersRepository.remove({ organizationId: existing.organizationId, agentId: existing.agentId, id: existing.id });
  const mapped = await agentPhoneNumbersRepository.add({ organizationId: org.id, agentId: agent.id, phoneNumber: FAKE_NUMBER, label: "preflight (temporary)" });

  const callSid = `preflight-${Date.now()}`;
  const streamSid = `stream-${callSid}`;
  try {
    // Register the call exactly as the recommended production setup does (inbound webhook first, stream second).
    // This keeps the preflight valid with STREAM_INBOUND_DIRECT_ALLOWED=false, where an unregistered call_sid is refused.
    const reg = await fetch(
      `${base}/api/telephony/exotel/inbound?${new URLSearchParams({ token: secret, CallSid: callSid, CallTo: FAKE_NUMBER, CallFrom: "+919000000098" })}`,
      { headers: { "ngrok-skip-browser-warning": "1" } },
    );
    record("inbound webhook registers the call (dialed number routes to an agent)", reg.ok, `HTTP ${reg.status}`);
    const ws = new WebSocket(wsUrl(secret), { handshakeTimeout: 10_000 });
    const heard = { chunks: 0, badChunks: 0, marks: [] as string[], clear: 0 };
    let sawStreamSid = true;
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { event?: string; stream_sid?: string; media?: { payload?: string }; mark?: { name?: string } };
      if (f.stream_sid !== streamSid) sawStreamSid = false;
      if (f.event === "media") {
        const n = Buffer.from(f.media?.payload ?? "", "base64").length;
        heard.chunks++;
        if (n < 3200 || n % 320 !== 0 || n > 100_000) heard.badChunks++;
      } else if (f.event === "mark" && f.mark?.name) {
        heard.marks.push(f.mark.name);
        ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: f.mark.name } }));
      } else if (f.event === "clear") heard.clear++;
    });
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    record("stream with the correct token connects", true);

    let seq = 0;
    const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify({ ...frame, sequence_number: String(++seq) }));
    send({ event: "connected" });
    send({
      event: "start",
      stream_sid: streamSid,
      start: {
        stream_sid: streamSid,
        call_sid: callSid,
        account_sid: "preflight",
        from: "+919000000088",
        to: FAKE_NUMBER,
        custom_parameters: {},
        media_format: { encoding: "audio/x-raw", sample_rate: "8000", bit_rate: "16" },
      },
    });

    const waitFor = async (label: string, cond: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) return record(label, false, "timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
      record(label, true);
    };

    await waitFor("agent greets the caller (routed by the dialed number)", () => heard.marks.length >= 1);

    const quiet = Buffer.alloc(FRAME);
    const turns = ["Hi, I am interested in your project.", "What is the price of a 2 BHK?"];
    for (const [i, text] of turns.entries()) {
      const speech = encodeMockSpeech(text);
      for (let o = 0; o < speech.length; o += FRAME) {
        send({ event: "media", stream_sid: streamSid, media: { chunk: String(++seq), payload: speech.subarray(o, o + FRAME).toString("base64") } });
      }
      for (let k = 0; k < 10; k++) {
        send({ event: "media", stream_sid: streamSid, media: { chunk: String(++seq), payload: quiet.toString("base64") } });
      }
      await waitFor(`agent replies to caller turn ${i + 1}`, () => heard.marks.length >= i + 2);
    }

    record("every outbound chunk is 3,200-100,000 bytes and a multiple of 320", heard.chunks > 0 && heard.badChunks === 0, `${heard.chunks} chunks, ${heard.badChunks} invalid`);
    record("every outbound frame carries the stream_sid", sawStreamSid);

    send({ event: "stop", stream_sid: streamSid, stop: { call_sid: callSid, account_sid: "preflight", reason: "callended" } });
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);

    // The call must exist, belong to the demo organization and the agent, and be closed.
    let row = await callsRepository.findByProviderCallIdAnyOrg({ providerCallId: callSid });
    for (let i = 0; i < 40 && row && row.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      row = await callsRepository.findByProviderCallIdAnyOrg({ providerCallId: callSid });
    }
    record("call recorded for the right organization and agent", !!row && row.organizationId === org.id && row.agentId === agent.id, row ? `type=${row.callType}` : "no record");
    record("call completed when the stream stopped", row?.status === "completed", `status=${row?.status}`);
  } catch (err) {
    record("full call over the public URL", false, err instanceof Error ? err.message : String(err));
  } finally {
    await agentPhoneNumbersRepository.remove({ organizationId: org.id, agentId: agent.id, id: mapped.id });
  }
  finish();
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  void sql.end({ timeout: 5 }).finally(() => process.exit(failed.length === 0 ? 0 : 1));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  void sql.end({ timeout: 5 }).finally(() => process.exit(1));
});
