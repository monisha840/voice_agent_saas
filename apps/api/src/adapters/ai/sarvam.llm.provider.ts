/**
 * Real Sarvam LLM adapter.
 *
 * Endpoint (documented, OpenAI-compatible): POST https://api.sarvam.ai/v1/chat/completions
 * Body: { model, messages, tools?, stream?, reasoning_effort? } — OpenAI tool-calling shape.
 * Auth: `api-subscription-key: <key>` (Sarvam's header) and `Authorization: Bearer <key>` (OpenAI-tooling form); both
 * are accepted per the docs, both are sent.
 * Reference: https://docs.sarvam.ai/api-reference/chat/chat-completions and /api/chat-completion/overview
 *
 * Streaming (`stream: true`), as documented: Server-Sent Events, each `data:` line a `chat.completion.chunk` whose
 * `choices[0].delta` carries `content` (reply text) and, when thinking is on, `reasoning_content` (thinking, never
 * spoken); the last content chunk has `finish_reason`; an optional chunk with empty `choices` carries `usage`; the
 * stream ends with `data: [DONE]`.
 *   NOT documented: the shape of streamed TOOL CALL deltas. We follow the OpenAI-compatible convention
 *   (StreamingToolCalls in openai-compat.ts) and only hand a tool call back once the stream has finished.
 *   NOT documented: any language parameter. Language comes from the system prompt (modules/ai-agent/persona.ts).
 *
 * Thinking mode is ON by default on Sarvam chat and its tokens count toward max_tokens and latency. Voice replies
 * usually want it off: SARVAM_LLM_REASONING_EFFORT=off sends `reasoning_effort: null` (the documented way to disable
 * it). Unset sends nothing (current behaviour).
 *
 * This file contains ALL Sarvam LLM-specific request/response details. Timeouts, retries and the circuit breaker are
 * applied around it by the provider factory (adapters/ai/index.ts); the first-token and stall timeouts, which only
 * mean something for a stream, are enforced here.
 */

import type { ChatMessage, ChatResult, ILanguageModel, LlmStreamHandlers, ToolDefinition } from "./llm.interface.js";
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";
import { getConfig } from "../../config/env.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { badResponse, httpFailure, transportFailure } from "./provider-errors.js";
import { parseOpenAiToolCalls, StreamingToolCalls, toOpenAiMessage, toOpenAiTool } from "./openai-compat.js";
import { readSse, SseOverflowError } from "./sse.js";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const PROVIDER = "sarvam";
const OPERATION = "llm.chat";
const STREAM_OPERATION = "llm.stream";
/** Backstop only, for use without the reliability wrapper; the wrapper passes its own (shorter) signal. */
const FALLBACK_TIMEOUT_MS = 30_000;

export class SarvamLlmProvider implements ILanguageModel {
  readonly name = "sarvam-105b";
  readonly capabilities: ProviderCapabilities = { toolCalling: true, parallelToolCalls: true, streamingLlm: true };

  /** `url` is a test seam (a local protocol server); production uses Sarvam's endpoint. */
  constructor(private readonly url: string = SARVAM_CHAT_URL) {}

  private request(messages: ChatMessage[], tools: ToolDefinition[], stream: boolean) {
    const { sarvam } = getConfig();
    if (!sarvam.apiKey) {
      throw new ProviderConfigError(
        PROVIDER,
        "SARVAM_API_KEY is not configured. Set AI_PROVIDER=mock to develop/demo without real Sarvam credentials.",
      );
    }
    const effort = sarvam.llmReasoningEffort;
    const body: Record<string, unknown> = {
      model: sarvam.llmModel,
      messages: messages.map(toOpenAiMessage),
      tools: tools.length > 0 ? tools.map(toOpenAiTool) : undefined,
      ...(stream ? { stream: true } : {}),
      // "" = not sent (API default); "off" = null (disables thinking); anything else passes through.
      ...(effort === "" ? {} : { reasoning_effort: effort === "off" ? null : effort }),
    };
    return {
      body: JSON.stringify(body),
      headers: {
        "api-subscription-key": sarvam.apiKey,
        Authorization: `Bearer ${sarvam.apiKey}`,
        "Content-Type": "application/json",
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
    };
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult> {
    const { body, headers } = this.request(messages, tools, false);

    let response: Response;
    try {
      response = await fetch(this.url, { method: "POST", headers, body, signal: opts?.signal ?? AbortSignal.timeout(FALLBACK_TIMEOUT_MS) });
    } catch (err) {
      throw transportFailure(PROVIDER, OPERATION, err);
    }

    if (!response.ok) throw httpFailure(PROVIDER, OPERATION, response);

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw badResponse(PROVIDER, OPERATION, "not JSON", err);
    }

    return parseChatCompletion(json);
  }

  /**
   * Streams one completion. Resolves with the assembled result once the provider has finished; text deltas are
   * reported through `handlers` as they arrive. No retries here (the reliability wrapper decides, and only before
   * anything was delivered). Everything is released on every exit: the timers, the abort link and the connection.
   */
  async chatStream(messages: ChatMessage[], tools: ToolDefinition[], handlers: LlmStreamHandlers, opts?: ProviderCallOptions): Promise<ChatResult> {
    const { body, headers } = this.request(messages, tools, true);
    const { providers } = getConfig();

    const ac = new AbortController();
    const caller = opts?.signal ?? AbortSignal.timeout(FALLBACK_TIMEOUT_MS);
    const onCallerAbort = () => ac.abort(caller.reason);
    if (caller.aborted) ac.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });

    let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = (what: string) => () => ac.abort(new DOMException(`llm stream ${what}`, "TimeoutError"));
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(timeout("stalled"), providers.llmStreamStallTimeoutMs);
      stallTimer.unref?.();
    };
    firstTokenTimer = setTimeout(timeout("produced no output in time"), providers.llmFirstTokenTimeoutMs);
    firstTokenTimer.unref?.();
    let bodyStream: ReadableStream<Uint8Array> | null = null;

    try {
      let response: Response;
      try {
        response = await fetch(this.url, { method: "POST", headers, body, signal: ac.signal });
      } catch (err) {
        throw transportFailure(PROVIDER, STREAM_OPERATION, err);
      }
      if (!response.ok) throw httpFailure(PROVIDER, STREAM_OPERATION, response);
      bodyStream = response.body;

      // A server that ignored `stream: true` and answered with a whole completion is still a valid answer.
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        let json: unknown;
        try {
          json = await response.json();
        } catch (err) {
          throw badResponse(PROVIDER, STREAM_OPERATION, "not JSON", err);
        }
        const whole = parseChatCompletion(json);
        if (whole.content) deliver(handlers, whole.content);
        return whole;
      }
      if (!bodyStream) throw badResponse(PROVIDER, STREAM_OPERATION, "no response body");

      armStall();
      let content = "";
      let finishReason: string | undefined;
      let usage: ChatResult["usage"];
      let sawDone = false;
      let gotOutput = false;
      const tools_ = new StreamingToolCalls();
      const markOutput = () => {
        if (gotOutput) return;
        gotOutput = true;
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      };

      try {
        for await (const data of readSse(bodyStream)) {
          armStall();
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            chunk = parsed as Record<string, unknown>;
          } catch (err) {
            throw badResponse(PROVIDER, STREAM_OPERATION, "malformed stream event", err);
          }
          if (chunk.error) {
            // A provider error delivered inside the stream. Its text is not copied (it may echo content).
            throw new ProviderRequestError(PROVIDER, `${PROVIDER} ${STREAM_OPERATION} reported an error mid-stream`, undefined, { category: "server", operation: STREAM_OPERATION });
          }
          const u = chunk.usage as Record<string, unknown> | null | undefined;
          if (u && typeof u === "object") {
            usage = {
              promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
              completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
              totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
            };
          }
          const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
          if (!choice) continue; // the usage-only chunk has no choices
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          const delta = choice.delta as Record<string, unknown> | undefined;
          if (!delta) continue;
          // delta.reasoning_content is thinking: it keeps the stream alive but is never spoken or stored.
          if (typeof delta.content === "string" && delta.content !== "") {
            markOutput();
            content += delta.content;
            deliver(handlers, delta.content);
          }
          if (delta.tool_calls !== undefined) {
            markOutput();
            if (!tools_.push(delta.tool_calls)) throw badResponse(PROVIDER, STREAM_OPERATION, "tool call exceeded size limits");
          }
        }
      } catch (err) {
        if (err instanceof ProviderRequestError) throw err;
        if (err instanceof SseOverflowError) throw badResponse(PROVIDER, STREAM_OPERATION, "stream event too large", err);
        throw transportFailure(PROVIDER, STREAM_OPERATION, err); // abort, timeout, or the connection dropping mid-stream
      }

      // The connection ended without [DONE] or any finish reason: the answer is cut off, not complete.
      if (!sawDone && finishReason === undefined) throw badResponse(PROVIDER, STREAM_OPERATION, "stream ended before completion");

      if (tools_.count > 0) {
        const { calls, incomplete } = tools_.finish();
        if (incomplete) throw badResponse(PROVIDER, STREAM_OPERATION, "incomplete tool call");
        return { toolCalls: calls, finishReason, usage };
      }
      if (content === "" && finishReason === "length") {
        // Typically thinking consumed the whole token budget. Reported, not hidden.
        logger.warn("sarvam llm stream: empty reply, token budget exhausted", { callId: opts?.callId, finishReason });
      }
      return { content, finishReason, usage };
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (stallTimer) clearTimeout(stallTimer);
      caller.removeEventListener("abort", onCallerAbort);
      if (!ac.signal.aborted) ac.abort(); // release the connection if we stopped reading early; the result is already built
      void bodyStream?.cancel().catch(() => undefined);
    }
  }
}

/** Handler faults must never break the stream. */
function deliver(handlers: LlmStreamHandlers, text: string): void {
  try {
    handlers.onTextDelta(text);
  } catch (err) {
    logger.error("sarvam llm stream: delta handler threw", { errorName: err instanceof Error ? err.name : "UnknownError" });
  }
}

function parseChatCompletion(json: unknown): ChatResult {
  const obj = (json ?? {}) as Record<string, unknown>;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;

  if (!message) throw badResponse(PROVIDER, OPERATION, "missing choices[0].message");

  const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls && rawToolCalls.length > 0) {
    return { toolCalls: parseOpenAiToolCalls(rawToolCalls) };
  }

  return { content: typeof message.content === "string" ? message.content : "" };
}
