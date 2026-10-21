import type { AiTool, ToolExecutionContext, ToolModule, ToolRequirement } from "./types.js";
import { endCall } from "./end_call.js";

export type { ToolExecutionContext, ToolModule, ToolRequirement } from "./types.js";
export { END_CALL_TOOL_NAME } from "./end_call.js";

/**
 * The tools the LLM may call during a live conversation. This is the ONLY way the AI can read or write
 * application data.
 *
 * The registry starts with the core tools (end_call). Modules add their own through registerModule (see
 * modules/modules/module-runtime.ts); nothing here imports a module's tools. A tool that is not registered
 * cannot be offered or executed, whatever an agent's stored tool list says.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = AiTool<any, any>;

const registry = new Map<string, AnyTool>();
registry.set(endCall.definition.name, endCall as AnyTool);

/**
 * Names of every registered tool, for validating per-agent allow-lists. Kept as one live array (updated in
 * place on every register/unregister) so existing importers always see the current registry.
 * Order is the historical one: module tools in registration order, then core tools.
 */
export const ALL_TOOL_NAMES: string[] = [];
/** Names of the tools that belong to the always-on core. Live, like ALL_TOOL_NAMES. */
export const CORE_TOOL_NAMES: string[] = [];

function moduleOf(tool: AnyTool): ToolModule {
  return tool.module ?? "core";
}

function orderedTools(): AnyTool[] {
  const all = [...registry.values()];
  return [...all.filter((t) => moduleOf(t) !== "core"), ...all.filter((t) => moduleOf(t) === "core")];
}

function refreshNames(): void {
  ALL_TOOL_NAMES.splice(0, ALL_TOOL_NAMES.length, ...orderedTools().map((t) => t.definition.name));
  CORE_TOOL_NAMES.splice(0, CORE_TOOL_NAMES.length, ...orderedTools().filter((t) => moduleOf(t) === "core").map((t) => t.definition.name));
}
refreshNames();

/** Adds (or replaces) a tool. end_call is owned by the core and cannot be replaced. */
export function registerTool(tool: AnyTool): void {
  const name = tool.definition.name;
  if (name === END_CALL_NAME) throw new Error(`Tool "${name}" is reserved by the core`);
  registry.set(name, tool);
  refreshNames();
}

export function unregisterTool(name: string): void {
  if (name === END_CALL_NAME) return;
  registry.delete(name);
  refreshNames();
}

const END_CALL_NAME = endCall.definition.name;

export function isKnownToolName(name: string): boolean {
  return registry.has(name);
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  module: ToolModule;
  requires: ToolRequirement[];
}

/** Metadata for every registered tool in registry order (what the UI lists and the resolver filters on). */
export function getToolCatalog(): ToolCatalogEntry[] {
  return orderedTools().map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    module: moduleOf(t),
    requires: [...(t.requires ?? [])],
  }));
}

/**
 * Allow-list semantics. `undefined` means the caller applies no restriction (only a session with no agent at
 * all, e.g. a unit test). Any array, INCLUDING AN EMPTY ONE, is strict: just those tools, and end_call is always
 * allowed so a call can always be ended.
 */
function isAllowed(name: string, allowed?: readonly string[]): boolean {
  if (allowed === undefined) return true;
  return name === END_CALL_NAME || allowed.includes(name);
}

export function getToolDefinitions(allowed?: readonly string[]) {
  return orderedTools().filter((t) => isAllowed(t.definition.name, allowed)).map((t) => t.definition);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  allowed?: readonly string[],
): Promise<unknown> {
  const tool = registry.get(name);
  // A tool outside the allow-list is indistinguishable from a nonexistent one.
  if (!tool || !isAllowed(name, allowed)) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Tool execution failed" };
  }
}
