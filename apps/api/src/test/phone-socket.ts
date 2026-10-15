/**
 * A bare-bones "phone" for tests: connects to the media-stream WebSocket the way Exotel does, sends the connected and
 * start events, echoes every `mark` back immediately (as if the agent's audio finished playing), and records what it
 * saw. Unlike simulator/call-simulator.ts it says nothing on its own, which is what the silence and duration tests need.
 */
import WebSocket from "ws";

export interface PhoneSocket {
  ws: WebSocket;
  /** Agent utterances heard so far: one entry per `mark` (the agent sends a mark after each utterance's audio). */
  marks: Array<{ name: string; atMs: number }>;
  /** Resolves when the server closes the socket (or it drops). */
  closed: Promise<{ code: number; atMs: number }>;
  isOpen(): boolean;
  waitForMarks(count: number, timeoutMs?: number): Promise<void>;
  /** Hang up from the phone's side (Exotel sends a stop event, then the socket closes). */
  hangUp(): Promise<void>;
}

export async function openPhone(
  baseUrl: string,
  opts: { callSid: string; internalCallId?: string; to?: string; from?: string; token?: string; streamToken?: string; grant?: string; accountSid?: string },
): Promise<PhoneSocket> {
  const params = new URLSearchParams();
  if (opts.internalCallId) params.set("internalCallId", opts.internalCallId);
  if (opts.token) params.set("token", opts.token);
  if (opts.streamToken) params.set("st", opts.streamToken);
  if (opts.grant) params.set("g", opts.grant);
  const qs = params.toString();
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/telephony/exotel/media-stream${qs ? `?${qs}` : ""}`);
  const t0 = Date.now();
  const streamSid = `stream-${opts.callSid}`;
  const marks: PhoneSocket["marks"] = [];

  ws.on("error", () => undefined); // a refused or dropped socket is asserted through `closed`, not as a thrown error
  ws.on("message", (raw) => {
    let frame: { event?: string; mark?: { name?: string } };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (frame.event === "mark" && frame.mark?.name) {
      marks.push({ name: frame.mark.name, atMs: Date.now() - t0 });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: frame.mark.name } }));
      }
    }
  });
  const closed = new Promise<{ code: number; atMs: number }>((resolve) => {
    ws.on("close", (code) => resolve({ code, atMs: Date.now() - t0 }));
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(
    JSON.stringify({
      event: "start",
      stream_sid: streamSid,
      start: {
        stream_sid: streamSid,
        call_sid: opts.callSid,
        account_sid: opts.accountSid ?? "test-account",
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.to ? { to: opts.to } : {}),
        media_format: { encoding: "pcm_s16le", sample_rate: "8000", bit_rate: "128kbps" },
      },
    }),
  );

  return {
    ws,
    marks,
    closed,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    async waitForMarks(count, timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs;
      while (marks.length < count) {
        if (Date.now() > until) throw new Error(`expected ${count} agent utterances, heard ${marks.length}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async hangUp() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "stop", stream_sid: streamSid, stop: { call_sid: opts.callSid, reason: "hangup" } }));
        ws.close();
      }
      await closed;
    },
  };
}
