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
 * This handler owns the Exotel protocol and wires the pieces together:
 *   - frame decode / encode ........ websocket/exotel-audio.ts (Exotel-specific)
 *   - VAD, turn state, cancellation,
 *     bounded utterance queue, metrics realtime/turn-controller.ts (provider-neutral)
 *   - bounded outbound audio ....... realtime/outbound-audio.ts
 *   - STT/TTS ...................... adapters/ai; conversation turns and tools -> modules/ai-agent/conversation.ts;
 *                                    call status -> modules/calls.
 *
 * Turn-taking: an explicit state machine (realtime/turn-state.ts), one turn in flight at a time, each turn with its
 * own cancellation signal. Barge-in exists but is OFF unless REALTIME_BARGE_IN=true: by default the agent is
 * half-duplex and inbound audio is ignored while it speaks (until Exotel returns our `mark`, or a duration-based
 * timeout). The customer's turn ends when the VAD sees `endSilenceMs` of quiet after speech: Exotel streams
 * continuous frames, so frame gaps cannot be used.
 */
import type { WebSocket } from "ws";
import { getSttProvider, getTtsProvider, getLlmProvider } from "../adapters/ai/index.js";
import { ConversationSession, type ConversationTurnResult, type LlmTurnObserver, type TurnOptions } from "../modules/ai-agent/conversation.js";
import { synthesizeWithVoice } from "../adapters/ai/tts-voice.js";
import { callsService } from "../modules/calls/calls.service.js";
import { systemContext } from "../auth/context.js";
import { callRuntime } from "../modules/calls/call-runtime.js";
import { detectReplyLanguage, replyLanguageName } from "../modules/ai-agent/reply-language.js";
import { reviewReply } from "../modules/ai-agent/reply-quality.js";
import { collapseRepetition } from "../modules/ai-agent/stt-text.js";
import { detectLanguageSwitchRequest, shouldIgnoreUtterance } from "../modules/ai-agent/caller-input.js";
import { chunkPcmForExotel, pcm16ToWav, pcmDurationMs, ttsAudioToPcm } from "../audio/pcm.js";
import { TurnDetector } from "../audio/turn-detector.js";
import { getConfig } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { lifecycle } from "../runtime/lifecycle.js";
import { CallGuard, GUARD_LINES } from "./call-guard.js";
import { NotFoundError, ProviderRequestError } from "../shared/errors.js";
import { DEFAULT_SAMPLE_RATE } from "../realtime/audio-format.js";
import { OutboundAudioSender } from "../realtime/outbound-audio.js";
import { TurnController, type TurnContext } from "../realtime/turn-controller.js";
import { SttStreamCoordinator } from "../realtime/stt-stream.js";
import { StreamingSpeaker } from "../realtime/tts-stream.js";
import { decodeExotelMedia, exotelClearFrame, exotelMarkItem, exotelMediaItem, resolveExotelAudioFormat } from "./exotel-audio.js";

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
    /** Caller and dialed number; on an inbound call, `to` is the number that decides which agent answers. */
    from?: string;
    to?: string;
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
  /** The stream connected and the call was marked answered; only then may the stream's end close the call. */
  let callAnswered = false;
  let callFinished = false;
  const logCtx = () => ({ internalCallId });
  logger.info("media-stream: connected", logCtx());

  let stt: ReturnType<typeof getSttProvider>;
  try {
    stt = getSttProvider();
  } catch (err) {
    // A provider that was selected but cannot be built (e.g. REALTIME_STT_PROVIDER=assemblyai without its key) fails the
    // call loudly. It never silently becomes a different provider.
    logger.error("media-stream: STT provider unavailable, closing the call", { ...logCtx(), error: err instanceof Error ? err.message : String(err) });
    socket.close(1011, "stt provider unavailable");
    return;
  }
  const tts = getTtsProvider();
  const llm = getLlmProvider();
  const cfg = getConfig();
  const turnCfg = cfg.turn;
  const rt = cfg.realtime;

  let streamSid = "";
  let sampleRate = DEFAULT_SAMPLE_RATE;
  /** BCP-47 code from the agent configuration; undefined = the providers' own default. */
  let languageCode: string | undefined;
  /** The agent's configured TTS voice; undefined = the provider default. */
  let voice: string | undefined;
  /** Language the reply is spoken in. Equals the agent's language, unless the agent mirrors the caller's language. */
  let ttsLanguageCode: string | undefined;
  /** True when the agent answers in the language the caller is speaking (set per agent). */
  let replyInCallerLanguage = false;
  /** A language the caller explicitly asked for ("speak in English"). Sticky for the rest of the call. */
  let requestedLanguage: string | null = null;
  /** Aborted when the call ends, so an in-flight STT / LLM / TTS request stops instead of finishing for nobody. */
  const abort = new AbortController();
  let session: ConversationSession | null = null;
  let controller: TurnController | null = null;
  /** Present only when streaming STT is enabled and the provider supports it; otherwise each utterance is one batch request. */
  let sttStream: SttStreamCoordinator | null = null;
  /** True when streaming TTS is enabled and the provider supports it; otherwise each reply is one batch synthesis. */
  let ttsStreaming = false;
  let closed = false;
  /** Set once the guard has decided to end the call: stop taking customer audio and never start another turn. */
  let ending = false;
  let guard: CallGuard | null = null;
  let unregisterSession: (() => void) | null = null;
  let markCounter = 0;
  let malformedFrames = 0;
  /** The turn whose audio is being sent, so the sender can stamp "first audio byte" on it. */
  let speakingTurn: TurnContext | null = null;
  const playbackWaiters = new Map<string, () => void>();

  /** Outbound audio goes through a bounded queue, never straight into the socket. */
  const sender = new OutboundAudioSender({
    send: (payload) => {
      if (!closed) socket.send(payload);
    },
    bufferedAmount: () => socket.bufferedAmount,
    maxQueuedBytes: rt.maxOutboundQueueBytes,
    highWaterBytes: rt.outboundHighWaterBytes,
    onFirstAudioSent: () => speakingTurn?.metrics.mark("firstAudioByte"),
  });

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

  function providerErrorFields(err: unknown) {
    return err instanceof ProviderRequestError ? err.toLogFields() : {};
  }

  /**
   * Synthesizes `text` and queues it for Exotel as raw PCM chunks; resolves once playback finished (mark), the turn
   * was cancelled, or the wait timed out. A TTS/queue failure is logged and recorded on the turn, not thrown: the
   * caller's remaining steps (e.g. ending the call) still run.
   */
  async function speak(text: string, turn: TurnContext) {
    if (!text || closed || turn.signal.aborted) return;
    guard?.disarmSilence(); // the customer is not "silent" while the agent talks
    const generation = sender.generation; // audio queued for a turn that has since been interrupted is refused
    try {
      turn.metrics.mark("ttsStart");
      const result = await synthesizeWithVoice(tts, text, { sampleRate, languageCode: ttsLanguageCode, voice, signal: turn.signal, callId: internalCallId });
      turn.metrics.mark("ttsEnd");
      const pcm = ttsAudioToPcm(result.audio, result.format, sampleRate);
      const chunks = chunkPcmForExotel(pcm);
      if (chunks.length === 0 || turn.signal.aborted || !turn.beginAiSpeaking()) return;

      const name = `turn-${++markCounter}`;
      const audioMs = pcmDurationMs(chunks.reduce((n, c) => n + c.length, 0), sampleRate);
      const played = waitForPlayback(name, audioMs + PLAYBACK_GRACE_MS, turn);
      speakingTurn = turn;
      const queued = sender.enqueue([...chunks.map((c) => exotelMediaItem(streamSid, c)), exotelMarkItem(streamSid, name)], generation);
      if (!queued) {
        playbackWaiters.get(name)?.();
        if (!sender.isCurrent(generation)) return; // interrupted while synthesizing: nothing to say, not an error
        throw new Error("Outbound audio queue is full; the reply was not sent");
      }
      await played;
    } catch (err) {
      if (closed || abort.signal.aborted || turn.signal.aborted) return; // cancelled / call ended: expected
      turn.metrics.outcome = "error";
      turn.metrics.errorName = err instanceof Error ? err.name : "UnknownError";
      logger.error("media-stream: TTS/send failed", {
        ...logCtx(),
        turnId: turn.turnId,
        error: err instanceof Error ? err.message : String(err),
        ...providerErrorFields(err),
      });
    } finally {
      if (speakingTurn === turn) speakingTurn = null;
    }
  }

  function waitForPlayback(name: string, timeoutMs: number, turn: TurnContext): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        turn.signal.removeEventListener("abort", done);
        playbackWaiters.delete(name);
        // Moved to idle synchronously so frames that follow the mark in the same socket read are accepted as the
        // customer's speech.
        turn.endAiSpeaking();
        resolve();
      };
      const timer = setTimeout(() => {
        logger.warn("media-stream: playback mark not received, continuing", { ...logCtx(), name });
        done();
      }, timeoutMs);
      playbackWaiters.set(name, done);
      turn.signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Maps the conversation's notifications onto the turn's metrics. Timings and counts only: no text. Streamed chunks are
   * spoken by converse() when streaming TTS is on; otherwise the reply is synthesized whole from `result.spokenText`.
   */
  function llmObserver(turn: TurnContext): LlmTurnObserver {
    const m = turn.metrics;
    let hops = 0;
    let toolCalls = 0;
    return {
      onRequestStart: () => {
        hops++;
        m.set("llmHopStart");
        delete m.stamps.llmFirstToken; // these two describe the LAST request of the turn
        delete m.stamps.llmFirstChunk;
      },
      onFirstToken: () => m.set("llmFirstToken"),
      onFirstChunk: () => m.set("llmFirstChunk"),
      onHopComplete: (e) => {
        toolCalls += e.toolCalls;
        m.llmHops = hops;
        m.llmToolCalls = toolCalls;
        m.llmChunks = e.chunks;
        m.llmChars = e.chars;
        m.llmStreamed = e.streamed;
        m.llmFinishReason = e.finishReason;
        m.llmCompletionToks = e.completionTokens;
      },
    };
  }

  /**
   * Runs one conversation turn (`produce`) and speaks its reply. Batch TTS (default): the reply is synthesized whole once
   * the model has finished. Streaming TTS: each sentence is handed to TTS the moment the model completes it, so the
   * caller starts hearing the reply while the model is still writing the rest. Either way it resolves after playback.
   */
  async function converse(turn: TurnContext, produce: (opts: TurnOptions) => Promise<ConversationTurnResult>): Promise<ConversationTurnResult> {
    const observer = llmObserver(turn);
    if (!ttsStreaming) {
      const result = await produce({ signal: turn.signal, observer });
      turn.metrics.mark("llmEnd");
      await speak(result.spokenText, turn);
      return result;
    }
    guard?.disarmSilence();
    const speaker = new StreamingSpeaker({
      tts,
      turn,
      sender,
      sampleRate,
      languageCode: ttsLanguageCode,
      voice,
      callId: internalCallId,
      generation: sender.generation,
      maxHeldBytes: rt.maxOutboundQueueBytes,
      audioItem: (pcm) => exotelMediaItem(streamSid, pcm),
      markItem: (name) => exotelMarkItem(streamSid, name),
      nextMarkName: () => `turn-${++markCounter}`,
      waitForPlayback,
    });
    speakingTurn = turn;
    turn.metrics.ttsStreamed = true;
    try {
      let result: ConversationTurnResult;
      try {
        result = await produce({ signal: turn.signal, observer, onTextChunk: (c) => speaker.push(c.text) });
      } catch (err) {
        // The model failed part-way: finish speaking what was already complete (a cancelled turn is cut off instead).
        if (turn.signal.aborted) speaker.cancel();
        else await speaker.finish();
        throw err;
      }
      turn.metrics.mark("llmEnd");
      if (speaker.sentenceCount === 0) speaker.push(result.spokenText); // e.g. a fixed fallback line that was never streamed
      await speaker.finish();
      // The caller talked over this reply: the model's history keeps only what had been spoken.
      if (turn.metrics.interrupted) session?.noteInterrupted(speaker.synthesizedText);
      return result;
    } finally {
      speaker.dispose();
      turn.metrics.ttsSentences = speaker.sentenceCount;
      turn.metrics.ttsAudioMs = Math.round(speaker.audioMs);
      turn.metrics.ttsFallback = speaker.fallback;
      const err = speaker.error;
      if (err && !closed && !turn.signal.aborted) {
        turn.metrics.outcome = "error";
        turn.metrics.errorName = err instanceof Error ? err.name : "UnknownError";
        if (err instanceof ProviderRequestError) turn.metrics.errorCategory = err.category;
        logger.error("media-stream: streaming TTS failed", { ...logCtx(), turnId: turn.turnId, error: err instanceof Error ? err.message : String(err), ...providerErrorFields(err) });
      }
      if (speakingTurn === turn) speakingTurn = null;
    }
  }

  /** A caller turn: speech -> text -> conversation -> spoken reply. Every provider call carries the turn's signal. */
  async function runUserTurn(pcm: Buffer, turn: TurnContext) {
    if (closed || ending || !session) return;
    guard?.disarmSilence(); // transcribing and thinking take time that is not the customer's silence
    let text: string;
    let heardLanguage: string | undefined;
    if (sttStream) {
      // The audio was streamed to the provider while the caller spoke; only the final transcript is awaited here.
      // Partials never reach this point: they are not turns.
      const final = await sttStream.awaitFinal(turn.utteranceRef, turn.signal, turn.metrics);
      text = final.text;
      heardLanguage = final.languageCode;
    } else {
      turn.metrics.mark("sttStart");
      ({ text, languageCode: heardLanguage } = await stt.transcribe(pcm16ToWav(pcm, sampleRate), { languageCode, signal: turn.signal, callId: internalCallId }));
      turn.metrics.mark("sttEnd");
    }
    const cleaned = collapseRepetition(text);
    if (cleaned.collapsed) {
      logger.warn("media-stream: repeated words collapsed in the transcript", { ...logCtx(), turnId: turn.turnId, removedWords: cleaned.removedWords });
      text = cleaned.text;
    }
    if (!text.trim()) {
      turn.metrics.outcome = "empty";
      return;
    }
    // A cough, a breath or a click is transcribed as "um": it is not a caller turn. Only a short, filler-only sound is
    // dropped; the agent is not interrupted by it (barge-in needs sustained speech), spoken to, or recorded.
    const { speechStart, speechEnd } = turn.metrics.stamps;
    const speechMs =
      speechStart !== undefined && speechEnd !== undefined
        ? speechEnd - speechStart
        : Math.max(0, Math.round((pcm.length / 2 / sampleRate) * 1000) - turnCfg.endSilenceMs);
    if (shouldIgnoreUtterance(text, speechMs)) {
      logger.info("media-stream: ignored a short filler sound", { ...logCtx(), turnId: turn.turnId, speechMs });
      turn.metrics.outcome = "empty";
      return;
    }
    // An explicit request to change language wins over everything else, from this turn until another request.
    const requested = detectLanguageSwitchRequest(text);
    if (requested) {
      requestedLanguage = requested;
      ttsLanguageCode = requested;
      logger.info("media-stream: caller asked for a language", { ...logCtx(), turnId: turn.turnId, requestedLanguage });
    } else if (replyInCallerLanguage && !requestedLanguage) {
      // An agent that mirrors the caller answers in the language they just used; a short or unclear utterance keeps the current one.
      const detected = detectReplyLanguage(text, heardLanguage);
      if (detected) ttsLanguageCode = detected;
      // Language codes only, never the words: lets a wrong switch be seen in the logs.
      logger.info("media-stream: reply language", { ...logCtx(), turnId: turn.turnId, heardLanguage: heardLanguage ?? null, detected, replyLanguage: ttsLanguageCode ?? null });
    }
    const replyLanguage = requestedLanguage
      ? replyLanguageName(requestedLanguage)
      : replyInCallerLanguage
        ? replyLanguageName(ttsLanguageCode ?? "en-IN")
        : undefined;
    turn.metrics.mark("llmStart");
    let bookedThisTurn = false;
    const result = await converse(turn, (o) =>
      session!.handleUserUtterance(text, { ...o, replyLanguage, languageRequested: requestedLanguage !== null, onToolRun: (e) => (bookedThisTurn ||= e.booked) }),
    );
    // Monitoring only: measure the reply and name known problems. Lengths and flags, never the words themselves.
    if (!turn.signal.aborted) {
      const review = reviewReply({ text: result.spokenText, bookedThisTurn });
      const fields = { ...logCtx(), turnId: turn.turnId, words: review.words, chars: review.chars, flags: review.flags };
      if (review.flags.length > 0) logger.warn("media-stream: reply quality", fields);
      else logger.info("media-stream: reply quality", fields);
    }
    // A caller who interrupted the goodbye wants to keep talking: the model's end_call is not carried out.
    if (result.shouldEndCall && !turn.signal.aborted) {
      turn.metrics.outcome ??= "completed"; // ending the call aborts this very turn; it still finished
      endSession("ai_ended_call");
    }
  }

  /** The guard (silence or length limit) decided the call must end: one polite line, then hang up. */
  async function endForGuard(reason: "silence_timeout" | "max_duration", line: string) {
    if (closed || ending) return;
    ending = true;
    logger.warn("media-stream: ending call by guard", { ...logCtx(), reason });
    controller?.dropPending();
    // Do not talk over a turn that is in flight (runAiTurn refuses unless idle); in that case just hang up.
    await controller?.runAiTurn((turn) => speak(line, turn));
    endSession(reason);
  }

  /**
   * The audio stream is the one signal we always get, whether or not Exotel is also configured to send status
   * callbacks (calls arriving through an ExoPhone flow often have none). When it ends the call is over: close it and
   * run the summary/usage pipeline. A callback that arrives as well is a harmless duplicate (same atomic transition).
   */
  function finishCall(outcome: "completed" | "failed") {
    if (callFinished || !callAnswered || !internalCallId) return;
    callFinished = true;
    void callsService.endFromStream({ callId: internalCallId, outcome }).catch((err) => {
      logger.error("media-stream: failed to close the call at stream end", { ...logCtx(), error: err instanceof Error ? err.message : String(err) });
    });
  }

  function endSession(reason: string) {
    if (closed) return;
    logger.info("media-stream: ending session", { ...logCtx(), reason });
    closed = true;
    abort.abort(); // stop any provider request still running for this call
    finishCall(reason === "init_failed" ? "failed" : "completed");
    controller?.close();
    sttStream?.close();
    sender.close();
    guard?.stop();
    unregisterSession?.();
    unregisterSession = null;
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
    const known = await callsService.getCallByProviderCallId({ providerCallId: start.call_sid });
    if (known) return known;

    // Not one of ours yet. If the DIALED number belongs to an agent this is an inbound call that arrived straight on
    // the media stream (no webhook announced it first): route it by number, exactly like the inbound webhook does.
    // An outbound call's `to` is the customer's number, which is not an agent's, so it falls through to the wait below.
    if (start.to) {
      try {
        return await callsService.startInboundCall({ dialedNumber: start.to, callerNumber: start.from, providerCallId: start.call_sid });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err; // over a limit, shutting down, database trouble: do not guess
      }
    }

    // Outbound race: the record is linked to Exotel's call_sid right after Calls/connect returns.
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
    const audio = resolveExotelAudioFormat(start.media_format);
    sampleRate = audio.format.sampleRate;
    if (audio.rateFellBack || audio.encodingUnexpected) {
      logger.warn("media-stream: unexpected media_format, assuming 16-bit PCM", { ...logCtx(), mediaFormat: start.media_format, assumedSampleRate: sampleRate });
    }
    logger.info("media-stream: start event", {
      ...logCtx(),
      streamSid,
      callSid: start.call_sid,
      sampleRate,
      encoding: start.media_format?.encoding,
    });

    const call = await resolveCall(start);
    internalCallId = call.id;
    // The audio stream connecting means the customer picked up. Do not depend on a status callback to say so.
    try {
      await callsService.markAnsweredFromStream({ callId: call.id });
    } catch (err) {
      logger.error("media-stream: could not mark the call answered", { ...logCtx(), error: err instanceof Error ? err.message : String(err) });
    }
    callAnswered = true;
    const ctx = systemContext(call.organizationId, "media-stream");
    // Everything the conversation needs comes from the CALL: its agent (persona, prompt, language, tools) and, when a
    // module such as Sales is involved, the lead/project that module attaches. No lead is required.
    const runtime = await callRuntime.build(ctx, call);
    ttsLanguageCode = runtime.languageCode;
    replyInCallerLanguage = runtime.replyInCallerLanguage;
    // An agent that mirrors the caller lets the speech provider detect each turn's language: a fixed hint would make it
    // hear every turn in one language, however the caller actually speaks.
    languageCode = replyInCallerLanguage ? undefined : runtime.languageCode;
    voice = runtime.voice;
    const llmStreaming = rt.llmStreaming && !!llm.capabilities?.streamingLlm && !!llm.chatStream;
    if (rt.llmStreaming && !llmStreaming) {
      logger.warn("media-stream: streaming LLM requested but the provider cannot stream; using batch LLM", { ...logCtx(), provider: llm.name });
    }
    ttsStreaming = rt.ttsStreaming && !!tts.capabilities?.streamingTts && !!tts.startStreaming;
    if (rt.ttsStreaming && !ttsStreaming) {
      logger.warn("media-stream: streaming TTS requested but the provider cannot stream; using batch TTS", { ...logCtx(), provider: tts.name });
    }
    session = new ConversationSession(llm, runtime.toolContext, runtime.promptParams, runtime.config, { streaming: llmStreaming });

    // From here the call is live: a draining server waits for it, and the guards watch its length and silence.
    // The limits are read ONCE, now: configuration changes later never alter a call that is already running.
    if (closed) return; // the socket dropped while we were setting up
    const limits = getConfig().limits;
    unregisterSession = lifecycle.registerSession({
      callId: call.id,
      close: (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          // already closing
        }
      },
    });
    const ids = { callId: call.id, agentId: runtime.agent.id, organizationId: call.organizationId };
    if (rt.sttStreaming && stt.capabilities?.streamingStt && stt.startStreaming) {
      sttStream = new SttStreamCoordinator({
        stt,
        ids,
        sampleRate,
        languageCode,
        minSpeechMs: turnCfg.minSpeechMs,
        finalTimeoutMs: cfg.providers.sttTimeoutMs,
        maxQueuedBytes: rt.sttMaxQueuedBytes,
        callSignal: abort.signal,
      });
    } else if (rt.sttStreaming) {
      logger.warn("media-stream: streaming STT requested but the provider cannot stream; using batch STT", { ...logCtx(), provider: stt.name });
    }
    controller = new TurnController({
      ids,
      ...(sttStream ? { onVadEvent: sttStream.onVadEvent, onUtteranceDropped: sttStream.drop, onVadReset: sttStream.onVadReset } : {}),
      vad: newDetector(),
      callSignal: abort.signal,
      bargeIn: { enabled: rt.bargeInEnabled, minSpeechMs: rt.bargeInMinSpeechMs },
      maxPendingUtterances: rt.maxPendingUtterances,
      runUserTurn,
      // Barge-in: drop whatever audio is still queued for the interrupted reply, and tell Exotel to flush what it already
      // holds (audio we handed over earlier is otherwise still played to the caller).
      onInterrupt: (turn) => {
        sender.clear();
        if (!closed && streamSid && turn.metrics.stamps.firstAudioByte !== undefined) {
          try {
            socket.send(exotelClearFrame(streamSid));
          } catch {
            // socket gone: the call is ending anyway
          }
        }
      },
      onUserActivity: () => guard?.heardCustomer(),
      // Waiting on the customer again (unless the call is over).
      onIdle: () => {
        if (!closed && !ending) guard?.armSilence();
      },
      describeError: providerErrorFields,
    });
    const turns = controller;

    guard = new CallGuard({
      maxDurationMs: limits.maxCallDurationMs,
      silenceTimeoutMs: limits.silenceTimeoutMs,
      maxReprompts: limits.silenceReprompts,
      onReprompt: async () => {
        if (closed || ending) return;
        await turns.runAiTurn((turn) => speak(GUARD_LINES.reprompt, turn));
      },
      onSilenceEnd: () => endForGuard("silence_timeout", GUARD_LINES.silenceEnd),
      onMaxDuration: () => endForGuard("max_duration", GUARD_LINES.maxDuration),
    });
    guard.start();

    // The AI greets first; the controller ignores caller audio until that turn finishes.
    let openingError: unknown;
    await turns.runAiTurn(async (turn) => {
      turn.metrics.mark("llmStart");
      try {
        await converse(turn, (o) => session!.start(o));
      } catch (err) {
        openingError = err;
        throw err;
      }
    });
    if (openingError && !closed && !abort.signal.aborted) throw openingError;
  }

  function onMedia(parsed: ExotelEvent) {
    if (!controller || closed || ending) return;
    const decoded = decodeExotelMedia(parsed.media?.payload);
    if (!decoded.ok) {
      malformedFrames++;
      if (malformedFrames === 1 || malformedFrames % 25 === 0) {
        logger.warn("media-stream: malformed audio frame dropped", { ...logCtx(), reason: decoded.reason, count: malformedFrames });
      }
      if (malformedFrames > rt.maxMalformedFrames) endSession("malformed_audio");
      return;
    }
    controller.pushAudio(decoded.pcm);
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
    finishCall("completed"); // the stream dropped without a stop event: the call is over all the same
    closed = true;
    abort.abort();
    controller?.close();
    sttStream?.close();
    sender.close();
    guard?.stop();
    unregisterSession?.();
    unregisterSession = null;
    playbackWaiters.forEach((done) => done());
    logger.info("media-stream: closed", logCtx());
  });

  socket.on("error", (err) => {
    logger.error("media-stream: socket error", { ...logCtx(), error: err.message });
  });
}
