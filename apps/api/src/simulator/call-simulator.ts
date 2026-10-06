/**
 * Deterministic local call simulator — plays the role of Exotel for one
 * outbound call, against the REAL HTTP/WebSocket endpoints of this API:
 *
 *   POST /api/telephony/exotel/status-callback   (ringing / answered / terminal)
 *   WS   /api/telephony/exotel/media-stream      (connected / start / media / mark / stop)
 *
 * It follows Exotel's documented AgentStream protocol: a `connected` event,
 * a nested `start` event with stream_sid/call_sid/media_format, raw 16-bit
 * 8 kHz PCM `media` frames (100 ms each, continuous — speech followed by
 * silence, as on a real call), `mark` echoes when the AI's audio "finishes
 * playing", and a `stop` event with a reason. It also validates what the
 * server sends back (stream_sid present, chunk sizes 3,200+ bytes and a
 * multiple of 320) and reports any violations.
 *
 * Customer speech is scripted text carried inside the PCM (see
 * encodeMockSpeech) so the mock STT can recover it exactly. The simulator
 * has no conversation logic, needs no credentials, internet or phone, and
 * does not model a real phone codec.
 */
import WebSocket from "ws";
import { encodeMockSpeech } from "../adapters/ai/mock.stt.provider.js";
import { getConfig } from "../config/env.js";
import { callsRepository } from "../db/repositories/calls.repository.js";
import { logger } from "../shared/logger.js";

export const DEFAULT_CUSTOMER_TURNS: readonly string[] = [
  "Hi, I'm interested in the Green Valley Residency project.",
  "I'm looking for a 2 BHK. My budget is around 70 lakhs.",
  "I would like to visit on Saturday morning.",
  "11:30 AM works for me.",
];

export type SimulatedScenario = "answered" | "busy" | "no_answer";

const SAMPLE_RATE = 8000;
const FRAME_BYTES = 1600; // 100 ms of 16-bit mono PCM at 8 kHz
const FRAME_MS = 100;

export interface SimulatedCallOptions {
  /** Base URL of this API, e.g. http://127.0.0.1:4000 */
  baseUrl: string;
  internalCallId: string;
  scenario?: SimulatedScenario;
  customerTurns?: readonly string[];
  /** Max wait for any single server reaction (AI audio, close, call linking). */
  stepTimeoutMs?: number;
  /** Re-send the final "completed" status callback (idempotency check). */
  duplicateCompletedCallback?: boolean;
  /**
   * Put ?internalCallId= on the WebSocket URL (what our real StreamUrl does).
   * Set false to prove the server can resolve the call from start.call_sid alone.
   */
  passInternalCallIdInUrl?: boolean;
}

export interface SimulationEvent {
  kind:
    | "status_callback"
    | "ws_connected"
    | "ws_start_sent"
    | "customer_turn"
    | "ai_audio"
    | "ws_stop_sent"
    | "ws_closed";
  detail?: string;
}

export interface SimulationReport {
  scenario: SimulatedScenario;
  providerCallId: string;
  events: SimulationEvent[];
  customerTurnsSent: string[];
  /** Number of AI utterances (each = media chunks followed by a mark). */
  aiAudioFrames: number;
  /** Anything the server sent that Exotel's protocol would reject. */
  protocolViolations: string[];
}

export async function runSimulatedCall(opts: SimulatedCallOptions): Promise<SimulationReport> {
  const scenario = opts.scenario ?? "answered";
  const turns = opts.customerTurns ?? DEFAULT_CUSTOMER_TURNS;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 15_000;
  const cfg = getConfig();
  const secret = cfg.exotel.agentStreamWebhookSecret;
  const events: SimulationEvent[] = [];
  const protocolViolations: string[] = [];
  const record = (e: SimulationEvent) => {
    events.push(e);
    logger.info(`call-simulator: ${e.kind}`, { internalCallId: opts.internalCallId, detail: e.detail });
  };

  // The route stores the provider call id right after initiateCall()
  // returns; status callbacks correlate on it, so wait until it is linked.
  const providerCallId = await waitForProviderCallId(opts.internalCallId, stepTimeoutMs);

  const authQuery = secret ? `?token=${encodeURIComponent(secret)}` : "";
  const postStatus = async (status: string, durationSeconds?: number) => {
    const res = await fetch(`${opts.baseUrl}/api/telephony/exotel/status-callback${authQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerCallId, status, durationSeconds }),
    });
    if (!res.ok) throw new Error(`status callback "${status}" failed: HTTP ${res.status}`);
    record({ kind: "status_callback", detail: status });
  };

  const report = (): SimulationReport => ({
    scenario,
    providerCallId,
    events,
    customerTurnsSent: events.filter((e) => e.kind === "customer_turn").map((e) => e.detail ?? ""),
    aiAudioFrames: events.filter((e) => e.kind === "ai_audio").length,
    protocolViolations,
  });

  await postStatus("ringing");
  if (scenario !== "answered") {
    await postStatus(scenario);
    return report();
  }
  await postStatus("in_progress");

  const startedAt = Date.now();
  const streamSid = `sim-stream-${opts.internalCallId}`;
  const params = new URLSearchParams();
  if (opts.passInternalCallIdInUrl !== false) params.set("internalCallId", opts.internalCallId);
  if (secret) params.set("token", secret);
  const qs = params.toString();
  const wsUrl = `${opts.baseUrl.replace(/^http/, "ws")}/api/telephony/exotel/media-stream${qs ? `?${qs}` : ""}`;
  const ws = new WebSocket(wsUrl);
  const inbox = new FrameInbox(ws, streamSid, stepTimeoutMs, protocolViolations);
  await inbox.opened;
  record({ kind: "ws_connected" });

  let seq = 0;
  const sendEvent = (frame: Record<string, unknown>) => ws.send(JSON.stringify({ ...frame, sequence_number: String(++seq) }));
  sendEvent({ event: "connected" });
  sendEvent({
    event: "start",
    stream_sid: streamSid,
    start: {
      stream_sid: streamSid,
      call_sid: providerCallId,
      account_sid: "sim-account",
      from: "+910000000000",
      to: "+910000000001",
      custom_parameters: {},
      media_format: { encoding: "audio/x-raw", sample_rate: String(SAMPLE_RATE), bit_rate: "16" },
    },
  });
  record({ kind: "ws_start_sent" });

  let chunk = 0;
  const sendPcmFrame = (pcm: Buffer) => {
    chunk += 1;
    sendEvent({
      event: "media",
      stream_sid: streamSid,
      media: { chunk: String(chunk), timestamp: String(chunk * FRAME_MS), payload: pcm.toString("base64") },
    });
  };
  const silenceFrames = Math.ceil((cfg.turn.endSilenceMs + 300) / FRAME_MS);

  // AI greets first; then each scripted customer turn -> one AI reply.
  const afterAi = async (label: string) => {
    const turn = await inbox.nextAiTurn();
    if (!turn) return null;
    record({ kind: "ai_audio", detail: `${label}: ${turn.chunks} chunks, ${turn.bytes} bytes` });
    // Exotel reports a mark once the audio finished playing to the caller.
    sendEvent({ event: "mark", stream_sid: streamSid, mark: { name: turn.markName } });
    return turn;
  };

  await afterAi("opening");
  for (const text of turns) {
    if (inbox.closed) break; // AI ended the call early
    record({ kind: "customer_turn", detail: text });
    const speech = encodeMockSpeech(text);
    for (let i = 0; i < speech.length; i += FRAME_BYTES) sendPcmFrame(speech.subarray(i, i + FRAME_BYTES));
    for (let i = 0; i < silenceFrames; i++) sendPcmFrame(Buffer.alloc(FRAME_BYTES)); // customer stops talking
    await afterAi("reply");
  }

  if (!inbox.closed) {
    sendEvent({
      event: "stop",
      stream_sid: streamSid,
      stop: { call_sid: providerCallId, account_sid: "sim-account", reason: "callended" },
    });
    record({ kind: "ws_stop_sent" });
  }
  await inbox.waitClosed();
  record({ kind: "ws_closed" });

  const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  await postStatus("completed", duration);
  if (opts.duplicateCompletedCallback) await postStatus("completed", duration);
  return report();
}

/**
 * Dev/test tool running inside the API process: reads the call record
 * directly (the dashboard API now requires a login the simulator does not have).
 */
async function waitForProviderCallId(callId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = await callsRepository.findByIdAnyOrg({ id: callId });
    if (call?.providerCallId) return call.providerCallId;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`call ${callId} never received a provider call id`);
}

interface AiTurn {
  chunks: number;
  bytes: number;
  markName: string;
}

/**
 * Queues inbound server frames and groups them into AI "turns": media
 * chunks followed by a mark. Validates each outbound frame against the
 * Exotel protocol rules.
 */
class FrameInbox {
  readonly opened: Promise<void>;
  closed = false;
  private pendingChunks = 0;
  private pendingBytes = 0;
  private turns: AiTurn[] = [];
  private waiters: Array<(t: AiTurn | null) => void> = [];
  private closeWaiters: Array<() => void> = [];

  constructor(
    ws: WebSocket,
    private readonly streamSid: string,
    private readonly timeoutMs: number,
    private readonly violations: string[],
  ) {
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (raw) => {
      let msg: { event?: string; stream_sid?: string; media?: { payload?: string }; mark?: { name?: string } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.violations.push("server sent a non-JSON frame");
        return;
      }
      if (msg.event === "media") {
        if (msg.stream_sid !== this.streamSid) this.violations.push("outbound media frame missing/incorrect stream_sid");
        const bytes = Buffer.from(msg.media?.payload ?? "", "base64").length;
        if (bytes < 3200 || bytes % 320 !== 0) {
          this.violations.push(`outbound media chunk of ${bytes} bytes (must be >=3200 and a multiple of 320)`);
        }
        this.pendingChunks += 1;
        this.pendingBytes += bytes;
      } else if (msg.event === "mark") {
        if (msg.stream_sid !== this.streamSid) this.violations.push("outbound mark frame missing/incorrect stream_sid");
        const turn: AiTurn = {
          chunks: this.pendingChunks,
          bytes: this.pendingBytes,
          markName: msg.mark?.name ?? "",
        };
        this.pendingChunks = 0;
        this.pendingBytes = 0;
        const w = this.waiters.shift();
        if (w) w(turn);
        else this.turns.push(turn);
      } else {
        this.violations.push(`server sent undocumented event "${msg.event}"`);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w(null));
      this.closeWaiters.splice(0).forEach((w) => w());
    });
  }

  /** Next complete AI utterance, or null if the server closed the socket first. */
  nextAiTurn(): Promise<AiTurn | null> {
    const queued = this.turns.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for AI audio")), this.timeoutMs);
      this.waiters.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
  }

  waitClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), this.timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
