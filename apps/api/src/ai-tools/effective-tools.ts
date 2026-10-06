import { getToolCatalog, END_CALL_TOOL_NAME } from "./index.js";

export interface EffectiveToolsInput {
  /** The agent's own tool selection. Empty means "nothing beyond end_call" here (not "all tools"). */
  enabledTools: readonly string[];
  /** Modules switched on for the organization. */
  enabledModules: readonly string[];
  /** What the call actually has: requirement name -> present. A requirement that is not listed is not met. */
  context: Readonly<Record<string, boolean>>;
}

/**
 * The tools a call may use: the agent's selection, limited to REGISTERED core tools plus registered tools of
 * enabled modules, limited to those whose required call context exists.
 *
 * Always contains end_call and is never empty. The result is meant to be passed as an EXPLICIT allow-list
 * (an empty list is strict, never "all tools"). A tool no module registered cannot appear, so a core with no
 * module plugged in can only ever offer end_call. Unknown names are dropped; order is registry order.
 */
export function resolveEffectiveTools(input: EffectiveToolsInput): string[] {
  const wanted = new Set(input.enabledTools);
  const modules = new Set(input.enabledModules);

  const names = getToolCatalog()
    .filter((t) => t.name === END_CALL_TOOL_NAME || wanted.has(t.name))
    .filter((t) => t.module === "core" || modules.has(t.module))
    .filter((t) => t.requires.every((r) => input.context[r] === true))
    .map((t) => t.name);

  return names.includes(END_CALL_TOOL_NAME) ? names : [END_CALL_TOOL_NAME, ...names];
}
