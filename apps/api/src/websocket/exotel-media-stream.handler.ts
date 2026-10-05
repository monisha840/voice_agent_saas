/**
 * Exotel AgentStream (Voicebot Applet) media-stream handler.
 *
 * Exotel is the WebSocket CLIENT: once a call we initiated is answered
 * and we gave Exotel a `StreamUrl`, Exotel connects to our WS endpoint
 * and streams bidirectional audio as JSON text frames:
 *
 *   { event: "start", stream_sid, call_sid, ... }
 *   { event: "media", media: { payload: "<base64 PCM/mulaw>" } }
 *   { event: "stop" }
 *
 * We respond with the same shape to send audio back to the caller:
 *   { event: "media", media: { payload: "<base64 audio>" } }
 *
 * Reference: https://developer.exotel.com/docs/agentstream/overview
 * (exact field names can vary by Exotel API version; this handler is
 * defensive about parsing and logs unrecognized event shapes rather
 * than crashing the call).
 *
 * This handler owns ONLY the audio-framing/session bridging. It
 * delegates:
 *   - speech-to-text / text-to-speech -> adapters/ai
 *   - conversation turns / tool calls -> modules/ai-agent/conversation.ts
 *   - call status -> modules/calls/calls.service.ts
 *
 * MVP simplification (explicit, per plan): turn-based only, no
 * real-time barge-in. We buffer inbound audio until a short silence
 * gap or a max-buffer timeout, then run one STT -> conversation ->
 * TTS round trip before accepting more audio.
 */

import type { WebSocket } from "ws";
import { getSttProvider, getTtsProvider, getLlmProvider } from "../adapters/ai/index.js";
import { ConversationSession } from "../modules/ai-agent/conversation.js";
import { callsService } from "../modules/calls/calls.service.js";
import { leadsService } from "../modules/leads/leads.service.js";
import { projectsService } from "../modules/projects/projects.service.js";
import { logger } from "../shared/logger.js";

const SILENCE_GAP_MS = 900;
const MAX_BUFFER_MS = 8000;
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM

interface ExotelEvent {
  event?: string;
  stream_sid?: string;
  call_sid?: string;
  media?: { payload?: string };
}

export async function handleExotelMediaStream(socket: WebSocket, internalCallId: string) {
  logger.info("media-stream: connected", { internalCallId });

  const stt = getSttProvider();
  const tts = getTtsProvider();
  const llm = getLlmProvider();

  let session: ConversationSession | null = null;
  let audioChunks: Buffer[] = [];
  let silenceTimer: NodeJS.Timeout | null = null;
  let maxBufferTimer: NodeJS.Timeout | null = null;
  let processing = false;
  let closed = false;

  function clearTimers() {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (maxBufferTimer) clearTimeout(maxBufferTimer);
    silenceTimer = null;
    maxBufferTimer = null;
  }

  async function sendAudioToExotel(audio: Buffer) {
    if (closed) return;
    const payload = audio.toString("base64");
    socket.send(JSON.stringify({ event: "media", media: { payload } }));
  }

  async function speak(text: string) {
    if (!text) return;
    try {
      const tts_result = await tts.synthesize(text);
      await sendAudioToExotel(tts_result.audio);
    } catch (err) {
      logger.error("media-stream: TTS failed", {
        internalCallId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function flushBufferedAudio() {
    if (processing || audioChunks.length === 0 || !session) return;
    processing = true;
    clearTimers();

    const audio = Buffer.concat(audioChunks);
    audioChunks = [];

    try {
      const { text } = await stt.transcribe(audio);
      if (text.trim()) {
        const turn = await session.handleUserUtterance(text);
        await speak(turn.spokenText);
        if (turn.shouldEndCall) {
          await endSession("ai_ended_call");
        }
      }
    } catch (err) {
      logger.error("media-stream: STT/conversation turn failed", {
        internalCallId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      processing = false;
    }
  }

  function scheduleFlush() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => void flushBufferedAudio(), SILENCE_GAP_MS);

    if (!maxBufferTimer) {
      maxBufferTimer = setTimeout(() => void flushBufferedAudio(), MAX_BUFFER_MS);
    }
  }

  async function endSession(_reason: string) {
    if (closed) return;
    closed = true;
    clearTimers();
    try {
      socket.send(JSON.stringify({ event: "stop" }));
    } catch {
      // socket may already be closing
    }
    socket.close();
  }

  async function initConversation() {
    const lead = await leadsService.getLeadOrThrow({ leadId: await resolveLeadId() });
    const project = await projectsService.getDefaultProject();

    session = new ConversationSession(
      llm,
      { leadId: lead.id, projectId: project.id, callId: internalCallId },
      { leadName: lead.name, projectName: project.name },
    );

    const opening = await session.start();
    await speak(opening.spokenText);
  }

  async function resolveLeadId(): Promise<string> {
    const call = await callsService.getCallDetail({ callId: internalCallId });
    if (!call) throw new Error(`No call record for internalCallId ${internalCallId}`);
    return call.leadId;
  }

  socket.on("message", (raw: Buffer) => {
    void (async () => {
      let parsed: ExotelEvent;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        logger.warn("media-stream: received non-JSON frame, ignoring", { internalCallId });
        return;
      }

      switch (parsed.event) {
        case "start":
          logger.info("media-stream: start event", { internalCallId, streamSid: parsed.stream_sid });
          try {
            await initConversation();
          } catch (err) {
            logger.error("media-stream: failed to initialize conversation", {
              internalCallId,
              error: err instanceof Error ? err.message : String(err),
            });
            await endSession("init_failed");
          }
          break;

        case "media": {
          const payload = parsed.media?.payload;
          if (!payload) return;
          audioChunks.push(Buffer.from(payload, "base64"));

          const bufferedMs =
            (audioChunks.reduce((sum, c) => sum + c.length, 0) / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
          if (bufferedMs >= MAX_BUFFER_MS) {
            void flushBufferedAudio();
          } else {
            scheduleFlush();
          }
          break;
        }

        case "stop":
          logger.info("media-stream: stop event received from Exotel", { internalCallId });
          await endSession("remote_stop");
          break;

        default:
          logger.warn("media-stream: unrecognized event", { internalCallId, event: parsed.event });
      }
    })();
  });

  socket.on("close", () => {
    closed = true;
    clearTimers();
    logger.info("media-stream: closed", { internalCallId });
  });

  socket.on("error", (err) => {
    logger.error("media-stream: socket error", { internalCallId, error: err.message });
  });
}
