import { getConfig } from "../../config/env.js";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import { MockSttProvider } from "./mock.stt.provider.js";
import { createAssemblyAiStt } from "./assemblyai/index.js"; // EXPERIMENT (see assemblyai/ASSEMBLYAI_EXPERIMENT.md)
import { MockLlmProvider } from "./mock.llm.provider.js";
import { MockTtsProvider } from "./mock.tts.provider.js";
import { ReliableLanguageModel, ReliableSpeechToText, ReliableTextToSpeech } from "./reliable-providers.js";
import type { ISpeechToText } from "./stt.interface.js";
import type { ILanguageModel } from "./llm.interface.js";
import type { ITextToSpeech } from "./tts.interface.js";

export type { ISpeechToText } from "./stt.interface.js";
export type { ILanguageModel, ChatMessage, ToolDefinition, ToolCallRequest, ChatResult } from "./llm.interface.js";
export type { ITextToSpeech, TtsOptions } from "./tts.interface.js";
export type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";

let sttCached: ISpeechToText | null = null;
let llmCached: ILanguageModel | null = null;
let ttsCached: ITextToSpeech | null = null;

/**
 * Returns the configured AI providers. Selection is explicit via
 * AI_PROVIDER ("mock" | "sarvam") — never silently switched at runtime.
 *
 * Every provider is returned wrapped in the reliability layer (timeout, bounded retry of transient failures,
 * cancellation, circuit breaker; see reliability.ts), so callers and future adapters get it for free.
 */
export function getSttProvider(): ISpeechToText {
  if (sttCached) return sttCached;
  const { aiProvider, realtime } = getConfig();
  // Explicit opt-in only. Never a fallback in either direction; a missing key fails here, loudly, not silently.
  if (realtime.sttProvider === "assemblyai") {
    sttCached = new ReliableSpeechToText(createAssemblyAiStt());
    return sttCached;
  }
  sttCached = new ReliableSpeechToText(aiProvider === "sarvam" ? new SarvamSttProvider() : new MockSttProvider());
  return sttCached;
}

export function getLlmProvider(): ILanguageModel {
  if (llmCached) return llmCached;
  const { aiProvider } = getConfig();
  llmCached = new ReliableLanguageModel(aiProvider === "sarvam" ? new SarvamLlmProvider() : new MockLlmProvider());
  return llmCached;
}

export function getTtsProvider(): ITextToSpeech {
  if (ttsCached) return ttsCached;
  const { aiProvider } = getConfig();
  ttsCached = new ReliableTextToSpeech(aiProvider === "sarvam" ? new SarvamTtsProvider() : new MockTtsProvider());
  return ttsCached;
}

/** Test seams: install (or clear with null) the provider used by the media-stream handler and call pipeline. */
export function setSttProvider(p: ISpeechToText | null): void {
  sttCached = p;
}
export function setLlmProvider(p: ILanguageModel | null): void {
  llmCached = p;
}
export function setTtsProvider(p: ITextToSpeech | null): void {
  ttsCached = p;
}
