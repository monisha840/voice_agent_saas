/**
 * Exotel AgentStream (Voicebot / Connect Voice AI) media-stream handler.
 *
 * Exotel is the WebSocket CLIENT: once the call we placed is answered it
 * connects to our StreamUrl and exchanges JSON text frames (see
 * https://developer.exotel.com/docs/agentstream/websocket-protocol):
 *
 *   Exotel -> us:  connected | start | media | mark | dtmf | stop
 *     start: { event, stream_sid, start: { stream_sid, call_sid, account_sid,
 *              from, to, custom_parameters, media_format: { encoding,
 *              sample_rate, bit_rate } } }
 *     media: { event, stream_sid, media: { chunk, timestamp, payload } }
 *     mark:  { event, stream_sid, mark: { name } }   (our audio finished playing)
 *     stop:  { event, stream_sid, stop: { call_sid, account_sid, reason } }
 *   us -> Exotel:  media | mark | clear   (every frame carries stream_sid)
 *     media: { event: "media", stream_sid, media: { payload } }
 *
 * Audio both ways is raw 16-bit little-endian mono PCM, base64-encoded.
 * Frames we send must be 3,200-100,000 bytes and a multiple of 320.
 *
 * This handler owns ONLY protocol/audio framing and turn-taking. It
 * delegates STT/TTS -> adapters/ai, conversation turns and tools ->
 * modules/ai-agent/conversation.ts, call status -> modules/calls.
 *
 * Turn-taking (MVP, explicit): half-duplex, no barge-in. Inbound audio is
 * ignored while the AI is speaking (until Exotel returns our `mark`, or a
 * duration-based timeout). The customer's turn ends when the turn detector
 * sees `endSilenceMs` of quiet after speech — Exotel streams continuous
 * frames, so frame gaps cannot be used.
 */
import type { WebSocket } from "ws";
import { getSttProvider, getTtsProvider, getLlmProvider } from "../adapters/ai/index.js";
import { ConversationSession } from "../modules/ai-agent/conversation.js";
import { callsService } from "../modules/calls/calls.service.js";
import { systemContext } from "../auth/context.js";
import { callRuntime } from "../modules/calls/call-runtime.js";
import { chunkPcmForExotel, pcm16ToWav, pcmDurationMs, ttsAudioToPcm } from "../audio/pcm.js";
import { TurnDetector } from "../audio/turn-detector.js";
import { getConfig } from "../config/env.js";
import { logger } from "../shared/logger.js";

const DEFAULT_SAMPLE_RATE = 8000;
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 24000];
/** Extra time beyond the audio's duration to wait for Exotel's `mark` before giving up. */
const PLAYBACK_GRACE_MS = 1500;
/** The call record is linked to Exotel's call_sid right after Calls/connect returns; allow for that race. */
const CALL_LOOKUP_ATTEMPTS = 10;
const CALL_LOOKUP_DELAY_MS = 300;

interface ExotelEvent {
  event?: string;
  stream_sid?: string;
  start?: {
    stream_sid?: string;
    call_sid?: string;
    account_sid?: string;
    custom_parameters?: Record<string, unknown>;
    media_format?: { encoding?: string; sample_rate?: string | number; bit_rate?: string | number };
  };
  media?: { chunk?: string; timestamp?: string; payload?: string };
  mark?: { name?: string };
  stop?: { call_sid?: string; reason?: string };
  dtmf?: { digit?: string };
}

export interface MediaStreamHints {
  /** Present when Exotel passes our StreamUrl query string through. Otherwise resolved from start.call_sid. */
  internalCallId?: string;
}

export function handleExotelMediaStream(socket: WebSocket, hints: MediaStreamHints = {}) {
  let internalCallId = hints.internalCallId;
  const logCtx = () => ({ internalCallId });
  logger.info("media-stream: connected", logCtx());

  const stt = getSttProvider();
  const tts = getTtsProvider();
  const llm = getLlmProvider();
  const turnCfg = getConfig().turn;

  let streamSid = "";
  let sampleRate = DEFAULT_SAMPLE_RATE;
  /** BCP-47 code from the agent configuration; undefined = the providers' own default. */
  let languageCode: string | undefined;
  let detector = newDetector();
  let session: ConversationSession | null = null;
  let aiSpeaking = false;
  let processing = false;
  let closed = false;
  let markCounter = 0;
  const pendingUtterances: Buffer[] = [];
  const playbackWaiters = new Map<string, () => void>();

  function newDetector() {
    return new TurnDetector({
      sampleRate,
      energyThreshold: turnCfg.energyThreshold,
      minSpeechMs: turnCfg.minSpeechMs,
      endSilenceMs: turnCfg.endSilenceMs,
      maxUtteranceMs: turnCfg.maxUtteranceMs,
      preRollMs: 200,
    });
  }

  function send(frame: Record<string, unknown>) {
    if (closed) return;
    socket.send(JSON.stringify(frame));
  }

  /** Synthesizes `text`, streams it to Exotel as raw PCM chunks, and resolves once playback finished (mark). */
  async function speak(text: string) {
    if (!text || closed) return;
    try {
      const result = await tts.synthesize(text, { sampleRate, languageCode });
      const pcm = ttsAudioToPcm(result.audio, result.format, sampleRate);
      const chunks = chunkPcmForExotel(pcm);
      if (chunks.length === 0) return;

      aiSpeaking = true;
      detector.reset();
      for (const chunk of chunks) {
        send({ event: "media", stream_sid: streamSid, media: { payload: chunk.toString("base64") } });
      }
      const name = `turn-${++markCounter}`;
      send({ event: "mark", stream_sid: streamSid, mark: { name } });
      const audioMs = pcmDurationMs(chunks.reduce((n, c) => n + c.length, 0), sampleRate);
      await waitForPlayback(name, audioMs + PLAYBACK_GRACE_MS);
    } catch (err) {
      aiSpeaking = false;
      logger.error("media-stream: TTS/send failed", {
        ...logCtx(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function waitForPlayback(name: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        playbackWaiters.delete(name);
        // Cleared synchronously so frames that follow the mark in the same
        // socket read are accepted as the customer's speech.
        aiSpeaking = false;
        resolve();
      };
      const timer = setTimeout(() => {
        logger.warn("media-stream: playback mark not received, continuing", { ...logCtx(), name });
        done();
      }, timeoutMs);
      playbackWaiters.set(name, done);
    });
  }

  async function drainUtterances() {
    if (processing) return;
    processing = true;
    try {
      while (pendingUtterances.length > 0 && !closed && session) {
        const pcm = pendingUtterances.shift()!;
        try {
          const { text } = await stt.transcribe(pcm16ToWav(pcm, sampleRate), { languageCode });
          if (!text.trim()) continue;
          const turn = await session.handleUserUtterance(text);
          await speak(turn.spokenText);
          if (turn.shouldEndCall) {
            endSession("ai_ended_call");
            return;
          }
        } catch (err) {
          logger.error("media-stream: STT/conversation turn failed", {
            ...logCtx(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      processing = false;
    }
  }

  function endSession(reason: string) {
    if (closed) return;
    logger.info("media-stream: ending session", { ...logCtx(), reason });
    closed = true;
    playbackWaiters.forEach((done) => done());
    try {
      socket.close();
    } catch {
      // socket may already be closing
    }
  }

  /**
   * Finds our call record: explicit query param, custom_parameters, or by
   * Exotel's call_sid. This is a SYSTEM lookup (no login on this socket; it is
   * protected by the webhook secret). From here on everything runs in the
   * organization that the call record itself belongs to.
   */
  async function resolveCall(start: NonNullable<ExotelEvent["start"]>) {
    const explicit = internalCallId ?? (typeof start.custom_parameters?.internalCallId === "string" ? start.custom_parameters.internalCallId : undefined);
    if (explicit) {
      const call = await callsService.getCallByIdSystem({ callId: explicit });
      if (!call) throw new Error(`No call record for internalCallId ${explicit}`);
      return call;
    }
    if (!start.call_sid) throw new Error("start event has no call_sid and no internalCallId was supplied");
    for (let i = 0; i < CALL_LOOKUP_ATTEMPTS; i++) {
      const call = await callsService.getCallByProviderCallId({ providerCallId: start.call_sid });
      if (call) return call;
      await new Promise((r) => setTimeout(r, CALL_LOOKUP_DELAY_MS));
    }
    throw new Error(`No call record for Exotel call_sid ${start.call_sid}`);
  }

  async function onStart(parsed: ExotelEvent) {
    const start = parsed.start ?? {};
    streamSid = parsed.stream_sid ?? start.stream_sid ?? "";
    const rate = Number(start.media_format?.sample_rate ?? DEFAULT_SAMPLE_RATE);
    sampleRate = SUPPORTED_SAMPLE_RATES.includes(rate) ? rate : DEFAULT_SAMPLE_RATE;
    detector = newDetector();
    aiSpeaking = true; // the AI greets first; ignore inbound audio until it finishes
    logger.info("media-stream: start event", {
      ...logCtx(),
      streamSid,
      callSid: start.call_sid,
      sampleRate,
      encoding: start.media_format?.encoding,
    });

    const call = await resolveCall(start);
    internalCallId = call.id;
    const ctx = systemContext(call.organizationId, "media-stream");
    // Everything the conversation needs comes from the CALL: its agent (persona, prompt, language, tools) and, when a
    // module such as Sales is involved, the lead/project that module attaches. No lead is required.
    const runtime = await callRuntime.build(ctx, call);
    languageCode = runtime.languageCode;
    session = new ConversationSession(llm, runtime.toolContext, runtime.promptParams, runtime.config);
    const opening = await session.start();
    await speak(opening.spokenText);
    aiSpeaking = false;
  }

  function onMedia(parsed: ExotelEvent) {
    const payload = parsed.media?.payload;
    if (!payload || !session || aiSpeaking || closed) return;
    const utterance = detector.push(Buffer.from(payload, "base64"));
    if (utterance) {
      pendingUtterances.push(utterance);
      void drainUtterances();
    }
  }

  socket.on("message", (raw: Buffer) => {
    let parsed: ExotelEvent;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      logger.warn("media-stream: received non-JSON frame, ignoring", logCtx());
      return;
    }

    switch (parsed.event) {
      case "connected":
        logger.info("media-stream: connected event", logCtx());
        break;
      case "start":
        void onStart(parsed).catch((err) => {
          logger.error("media-stream: failed to initialize conversation", {
            ...logCtx(),
            error: err instanceof Error ? err.message : String(err),
          });
          endSession("init_failed");
        });
        break;
      case "media":
        onMedia(parsed);
        break;
      case "mark": {
        const name = parsed.mark?.name;
        if (name) playbackWaiters.get(name)?.();
        break;
      }
      case "dtmf":
        logger.info("media-stream: dtmf ignored", { ...logCtx(), digit: parsed.dtmf?.digit });
        break;
      case "stop":
        logger.info("media-stream: stop event received from Exotel", {
          ...logCtx(),
          reason: parsed.stop?.reason,
        });
        endSession("remote_stop");
        break;
      default:
        logger.warn("media-stream: unrecognized event", { ...logCtx(), event: parsed.event });
    }
  });

  socket.on("close", () => {
    closed = true;
    playbackWaiters.forEach((done) => done());
    logger.info("media-stream: closed", logCtx());
  });

  socket.on("error", (err) => {
    logger.error("media-stream: socket error", { ...logCtx(), error: err.message });
  });
}
