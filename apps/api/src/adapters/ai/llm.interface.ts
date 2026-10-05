/**
 * ILanguageModel — the only LLM contract the conversation loop and the
 * AI tool layer depend on. The LLM NEVER receives DB credentials or
 * access; it receives a fixed tool list and returns either plain text
 * or a tool-call request. Tool *execution* happens outside the adapter,
 * in ai-tools/*, against module services.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on role: "assistant" tool-call messages. */
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  /** Present when the model produced a spoken/text response. */
  content?: string;
  /** Present when the model wants to call one or more tools. */
  toolCalls?: ToolCallRequest[];
}

export interface ILanguageModel {
  readonly name: string;
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult>;
}
