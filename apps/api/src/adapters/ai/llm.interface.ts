/**
 * ILanguageModel — the only LLM contract the conversation loop and the
 * AI tool layer depend on. The LLM NEVER receives DB credentials or
 * access; it receives a fixed tool list and returns either plain text
 * or a tool-call request. Tool *execution* happens outside the adapter,
 * in ai-tools/*, against module services.
 *
 * Provider-neutral: an adapter translates these types to and from its own wire format (see openai-compat.ts for
 * OpenAI-style endpoints) and reports failures as ProviderRequestError / ProviderConfigError (shared/errors.ts).
 */
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * role "assistant": the tool calls the model requested in this turn, ALL of them in this one message, with the
   * arguments the model gave. Each is answered by one role "tool" message with the matching toolCallId.
   */
  toolCalls?: ToolCallRequest[];
  /** role "tool": the id of the assistant tool call this message answers. */
  toolCallId?: string;
  /** Legacy: the name of the tool a role "tool" message answers; use toolCalls on the assistant message instead. */
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  /** Unique within the conversation once the conversation has normalised it; providers may send it empty. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** The model sent arguments that were not a JSON object. The tool must not be run on guessed arguments. */
  invalidArguments?: boolean;
}

export interface ChatResult {
  /** Present when the model produced a spoken/text response. */
  content?: string;
  /** Present when the model wants to call one or more tools. */
  toolCalls?: ToolCallRequest[];
  /** Why generation stopped, as the provider reported it ("stop", "length", "tool_calls", ...). Streaming only. */
  finishReason?: string;
  /** Token usage when the provider reports it. Never required. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/**
 * What a streaming generation reports while it runs. Text arrives as it is generated; everything else (a complete
 * tool call, the finish reason) is part of the RESULT that chatStream resolves with, never delivered mid-stream:
 * a tool call is only handed back once the provider has finished it, so nothing can act on half a call.
 */
export interface LlmStreamHandlers {
  /** A piece of the spoken/text reply. Called in order; never after chatStream settles. Must not throw. */
  onTextDelta(text: string): void;
}

export interface ILanguageModel {
  readonly name: string;
  readonly capabilities?: ProviderCapabilities;
  chat(messages: ChatMessage[], tools: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult>;
  /**
   * OPTIONAL streaming variant of chat(): same inputs, same ChatResult, but text deltas are reported through
   * `handlers` while the model is still generating. Cancelling `opts.signal` stops the generation and rejects
   * (cancelled); a failure after text was delivered rejects too and is NOT retried or replayed. Providers that cannot
   * stream leave it undefined (`capabilities.streamingLlm`).
   */
  chatStream?(messages: ChatMessage[], tools: ToolDefinition[], handlers: LlmStreamHandlers, opts?: ProviderCallOptions): Promise<ChatResult>;
}
