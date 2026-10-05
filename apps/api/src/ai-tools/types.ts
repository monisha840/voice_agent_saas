import type { ToolDefinition } from "../adapters/ai/llm.interface.js";

/**
 * An AiTool pairs the LLM-facing definition (name/description/JSON
 * schema) with a server-side executor. The executor NEVER touches the
 * database directly — it calls a module service. This is the only path
 * by which the LLM can affect or read application state:
 *
 *   LLM -> tool call -> AiTool.execute() -> module service -> repository -> Postgres
 *
 * Never: LLM -> SQL.
 */
export interface AiTool<TArgs = Record<string, unknown>, TResult = unknown> {
  definition: ToolDefinition;
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<TResult>;
}

/** Per-call context threaded through every tool execution. */
export interface ToolExecutionContext {
  leadId: string;
  projectId: string;
  callId: string;
}
