import { getConfig } from "../../config/env.js";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import { MockSttProvider } from "./mock.stt.provider.js";
import { MockLlmProvider } from "./mock.llm.provider.js";
import { MockTtsProvider } from "./mock.tts.provider.js";
import type { ISpeechToText } from "./stt.interface.js";
import type { ILanguageModel } from "./llm.interface.js";
import type { ITextToSpeech } from "./tts.interface.js";

export type { ISpeechToText } from "./stt.interface.js";
export type { ILanguageModel, ChatMessage, ToolDefinition, ToolCallRequest, ChatResult } from "./llm.interface.js";
export type { ITextToSpeech } from "./tts.interface.js";

let sttCached: ISpeechToText | null = null;
let llmCached: ILanguageModel | null = null;
let ttsCached: ITextToSpeech | null = null;

/**
 * Returns the configured AI providers. Selection is explicit via
 * AI_PROVIDER ("mock" | "sarvam") — never silently switched at runtime.
 */
export function getSttProvider(): ISpeechToText {
  if (sttCached) return sttCached;
  const { aiProvider } = getConfig();
  sttCached = aiProvider === "sarvam" ? new SarvamSttProvider() : new MockSttProvider();
  return sttCached;
}

export function getLlmProvider(): ILanguageModel {
  if (llmCached) return llmCached;
  const { aiProvider } = getConfig();
  llmCached = aiProvider === "sarvam" ? new SarvamLlmProvider() : new MockLlmProvider();
  return llmCached;
}

export function getTtsProvider(): ITextToSpeech {
  if (ttsCached) return ttsCached;
  const { aiProvider } = getConfig();
  ttsCached = aiProvider === "sarvam" ? new SarvamTtsProvider() : new MockTtsProvider();
  return ttsCached;
}
