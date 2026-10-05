import type { AiTool, ToolExecutionContext } from "./types.js";
import { getProjectDetails } from "./get_project_details.js";
import { getProjectPrice } from "./get_project_price.js";
import { getProjectConfigurations } from "./get_project_configurations.js";
import { getProjectLocation } from "./get_project_location.js";
import { checkVisitSlots } from "./check_visit_slots.js";
import { bookSiteVisit } from "./book_site_visit.js";
import { updateLead } from "./update_lead.js";
import { markNotInterested } from "./mark_not_interested.js";
import { endCall } from "./end_call.js";

export type { ToolExecutionContext } from "./types.js";
export { END_CALL_TOOL_NAME } from "./end_call.js";

/**
 * The fixed set of tools the LLM may call during a live conversation.
 * This is the ONLY way the AI can read or write application data.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_TOOLS: AiTool<any, any>[] = [
  getProjectDetails,
  getProjectPrice,
  getProjectConfigurations,
  getProjectLocation,
  checkVisitSlots,
  bookSiteVisit,
  updateLead,
  markNotInterested,
  endCall,
];

export function getToolDefinitions() {
  return ALL_TOOLS.map((t) => t.definition);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  const tool = ALL_TOOLS.find((t) => t.definition.name === name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Tool execution failed" };
  }
}
