/**
 * LLM sentence -> streaming TTS -> outbound audio, with the REAL ConversationSession (real sentence chunker, real
 * Postgres transcript), the mock streaming TTS provider and the REAL outbound queue. The key latency property:
 * TTS starts speaking sentence 1 BEFORE the model has produced its final sentence.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.AI_PROVIDER = "mock";

import { ConversationSession } from "../modules/ai-agent/conversation.js";
import type { ChatMessage, ChatResult, ILanguageModel, LlmStreamHandlers, ToolDefinition } from "../adapters/ai/llm.interface.js";
import type { ProviderCallOptions } from "../adapters/ai/provider-common.js";
import { MockTtsProvider } from "../adapters/ai/mock.tts.provider.js";
import { ReliableTextToSpeech } from "../adapters/ai/reliable-providers.js";
import { callsService } from "../modules/calls/calls.service.js";
import { defaultAgentIdFor } from "../test/tenants.js";
import { demoContext } from "../test/helpers.js";
import type { ToolExecutionContext } from "../ai-tools/types.js";
import { OutboundAudioSender, type OutboundItem } from "./outbound-audio.js";
import { StreamingSpeaker } from "./tts-stream.js";
import { TurnMetrics } from "./turn-metrics.js";
import type { TurnContext } from "./turn-controller.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 1000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await wait(2);
  return cond();
};

/** Streams `first`, then holds at `gate` before `rest` (the model "still thinking" mid-reply). */
class GatedLlm implements ILanguageModel {
  readonly name = "gated";
  readonly capabilities = { streamingLlm: true };
  gate!: () => void;
  private readonly gated = new Promise<void>((r) => (this.gate = r));
  constructor(
    private readonly first: string[],
    private readonly rest: string[],
  ) {}
  async chat(): Promise<ChatResult> {
    return { content: [...this.first, ...this.rest].join("") };
  }
  async chatStream(_m: ChatMessage[], _t: ToolDefinition[], h: LlmStreamHandlers, opts?: ProviderCallOptions): Promise<ChatResult> {
    for (const d of this.first) h.onTextDelta(d);
    await this.gated;
    if (opts?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    for (const d of this.rest) h.onTextDelta(d);
    return { content: [...this.first, ...this.rest].join(""), finishReason: "stop" };
  }
}

let ctx: ToolExecutionContext;
beforeAll(async () => {
  const org = await demoContext();
  const call = await callsService.createCall(org, { agentId: await defaultAgentIdFor(org.organizationId), callType: "test" });
  ctx = { organizationId: org.organizationId, callId: call.id };
});

function rig(tts: MockTtsProvider, voice?: string) {
  const abort = new AbortController();
  const wire: string[] = [];
  const sender = new OutboundAudioSender({ send: (p) => void wire.push(p), bufferedAmount: () => 0, maxQueuedBytes: 1_000_000, highWaterBytes: 100_000 });
  const metrics = new TurnMetrics("t1", "user", { callId: "c" }, Date.now);
  const turn: TurnContext = {
    turnId: "t1",
    kind: "user",
    signal: abort.signal,
    isActive: () => !abort.signal.aborted,
    metrics,
    utteranceRef: undefined,
    beginAiSpeaking: () => !abort.signal.aborted,
    endAiSpeaking: () => undefined,
  };
  let marks = 0;
  const speaker = new StreamingSpeaker({
    tts: new ReliableTextToSpeech(tts), // the production wrapper, so breaker + stall handling are in the path
    turn,
    sender,
    sampleRate: 8000,
    languageCode: "en-IN",
    voice,
    generation: sender.generation,
    maxHeldBytes: 1_000_000,
    audioItem: (pcm): OutboundItem => ({ payload: `A${pcm.length}`, weight: pcm.length, audio: true }),
    markItem: (n): OutboundItem => ({ payload: `M:${n}`, weight: 0, audio: false }),
    nextMarkName: () => `m${++marks}`,
    waitForPlayback: async () => undefined,
  });
  return { speaker, wire, abort, metrics, turn, sender };
}

// The chunker releases a sentence once the next token shows it ended, so the first delivery includes " I".
const FIRST = ["Hello", " Rajesh.", " I"];
const REST = [" can", " help", " you", " with", " the", " 2", " BHK", " options.", " Would", " you", " like", " a", " site", " visit?"];

describe("LLM sentence -> streaming TTS -> outbound audio", () => {
  it("TTS starts, and the caller hears audio, BEFORE the model produces its final sentence", async () => {
    const tts = new MockTtsProvider({ chunksPerSegment: 2, chunkBytes: 3200, chunkDelayMs: 3 });
    const r = rig(tts);
    const llm = new GatedLlm(FIRST, REST);
    const session = new ConversationSession(llm, ctx, {}, undefined, { streaming: true });

    const turnDone = session.handleUserUtterance("Tell me about it", { signal: r.abort.signal, onTextChunk: (c) => r.speaker.push(c.text) });

    // The model is stalled mid-reply (gate closed). Sentence 1 must already be at TTS and audible.
    expect(await until(() => tts.streamSessions[0]?.texts.length === 1)).toBe(true);
    expect(tts.streamSessions[0].texts).toEqual(["Hello Rajesh."]);
    expect(await until(() => r.wire.length >= 1)).toBe(true);
    expect(r.wire.filter((w) => w.startsWith("A")).length).toBeGreaterThan(0);
    expect(r.metrics.stamps.ttsStart).toBeDefined();
    expect(r.metrics.stamps.ttsFirstAudio).toBeDefined();
    expect(r.metrics.stamps.llmEnd).toBeUndefined(); // the LLM has NOT finished

    llm.gate(); // the model finishes
    const result = await turnDone;
    await wait(2); // a distinct millisecond for llmEnd
    r.metrics.mark("llmEnd");
    await r.speaker.finish();

    expect(tts.streamSessions[0].texts).toEqual(["Hello Rajesh.", "I can help you with the 2 BHK options.", "Would you like a site visit?"]);
    expect(result.chunks).toEqual(tts.streamSessions[0].texts);
    expect(r.metrics.stamps.ttsStart!).toBeLessThan(r.metrics.stamps.llmEnd!);
    expect(r.metrics.summary().ttsStartedBeforeLlmEnd).toBe(true);
    // 3 sentences x 2 chunks x 3200 B, in order, then exactly one mark at the very end.
    expect(r.wire).toEqual([...Array(6).fill("A3200"), "M:m1"]);
    expect(tts.streamSessions[0].closed).toBe(true);
  });

  it("the configured agent voice reaches the streaming provider; no voice leaves the provider default", async () => {
    for (const voice of ["meera", undefined]) {
      const tts = new MockTtsProvider();
      const r = rig(tts, voice);
      r.speaker.push("Hi.");
      await r.speaker.finish();
      expect(tts.streamSessions[0].voice).toBe(voice);
      expect(tts.streamSessions[0].languageCode).toBe("en-IN");
    }
  });

  it("a rejected voice falls back to the default voice, once, and the reply is still spoken", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tts = new MockTtsProvider({ invalidVoices: ["nope"] });
    const r = rig(tts, "nope");
    r.speaker.push("Hi there.");
    await r.speaker.finish();
    expect(tts.streamSessions.map((s) => s.voice)).toEqual(["nope", undefined]);
    expect(r.wire).toEqual(["A3200", "A3200", "M:m1"]); // 4000 B of audio: one full frame + a padded tail
    vi.restoreAllMocks();
  });

  it("cancelling the turn mid-reply stops TTS, and the model's later sentences go nowhere", async () => {
    const tts = new MockTtsProvider({ chunksPerSegment: 1, chunkDelayMs: 5 });
    const r = rig(tts);
    const llm = new GatedLlm(FIRST, REST);
    const session = new ConversationSession(llm, ctx, {}, undefined, { streaming: true });
    const turn = session.handleUserUtterance("Tell me more", { signal: r.abort.signal, onTextChunk: (c) => r.speaker.push(c.text) });
    turn.catch(() => undefined);
    await until(() => tts.streamSessions[0]?.texts.length === 1);
    r.abort.abort(); // interrupted / call ended
    llm.gate();
    await turn.catch(() => undefined);
    await r.speaker.finish();
    await wait(30);
    expect(tts.streamSessions[0].cancelled).toBe(true);
    expect(tts.streamSessions[0].texts).toEqual(["Hello Rajesh."]); // sentences 2 and 3 were never submitted
    expect(r.wire.some((w) => w.startsWith("M:"))).toBe(false); // no playback mark for a cancelled reply
    const delivered = r.wire.length;
    await wait(30);
    expect(r.wire.length).toBe(delivered); // nothing more arrives afterwards
  });
});
