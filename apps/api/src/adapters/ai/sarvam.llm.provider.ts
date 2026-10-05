/**
 * Real Sarvam-105B LLM adapter.
 *
 * Endpoint (documented, OpenAI-compatible): POST https://api.sarvam.ai/v1/chat/completions
 * Body: { model, messages, tools? } — OpenAI tool-calling shape.
 * Reference: https://docs.sarvam.ai/api-reference/chat/chat-completions
 *
 * This file contains ALL Sarvam LLM-specific request/response shapes,
 * including translating our generic ChatMessage/ToolDefinition types to
 * and from Sarvam's OpenAI-compatible wire format.
 */

import type {
  ChatMessage,
  ChatResult,
  ILanguageModel,
  ToolCallRequest,
  ToolDefinition,
} from "./llm.interface.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";

export class SarvamLlmProvider implements ILanguageModel {
  readonly name = "sarvam-105b";

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        "sarvam",
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }

    const body = {
      model: sarvam.llmModel,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length > 0 ? tools.map(toOpenAiTool) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(SARVAM_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sarvam.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Network error calling Sarvam chat completions API", err);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderRequestError(
        "sarvam",
        `Sarvam chat completions request failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new ProviderRequestError("sarvam", "Sarvam chat completions returned a malformed response", err);
    }

    return parseChatCompletion(json);
  }
}

function toOpenAiMessage(msg: ChatMessage) {
  if (msg.role === "tool") {
    return { role: "tool", content: msg.content, tool_call_id: msg.toolCallId };
  }
  return { role: msg.role, content: msg.content };
}

function toOpenAiTool(tool: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseChatCompletion(json: unknown): ChatResult {
  const obj = json as Record<string, unknown>;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;

  if (!message) {
    throw new ProviderRequestError("sarvam", "Sarvam chat completions response missing choices[0].message");
  }

  const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls && rawToolCalls.length > 0) {
    const toolCalls: ToolCallRequest[] = rawToolCalls.map((tc) => {
      const fn = tc.function as Record<string, unknown>;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(fn.arguments ?? "{}"));
      } catch {
        // Malformed tool-call arguments from the model — treat as empty args
        // rather than crashing the whole turn.
      }
      return { id: String(tc.id ?? ""), name: String(fn.name ?? ""), arguments: args };
    });
    return { toolCalls };
  }

  return { content: typeof message.content === "string" ? message.content : "" };
}
