import type { ToolDefinition } from "../adapters/ai/llm.interface.js";

/** "core" or the key of the module that owns the tool. */
export type ToolModule = string;
/** A named piece of call context a tool needs (e.g. "lead"); the core only compares names, a module defines what they mean. */
export type ToolRequirement = string;

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
  /** Which feature pack owns the tool. "core" tools are always available. Defaults to "core". */
  module?: ToolModule;
  /** Call records the tool needs; the tool is only offered when the call has them. */
  requires?: ToolRequirement[];
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<TResult>;
}

/** Per-call context threaded through every tool execution. */
export interface ToolExecutionContext {
  /** The organization this call belongs to. Fixed per call; the LLM cannot change it. */
  organizationId: string;
  callId: string;
  agentId?: string;
  callType?: "outbound" | "inbound" | "test";
  /**
   * Ids that modules attached to the call (e.g. the Sales module's leadId and projectId). The core never reads
   * them; a module's tools do. Absent on a plain call.
   */
  subject?: Readonly<Record<string, string>>;
}
