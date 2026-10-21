import { systemContext, type RequestContext } from "../auth/context.js";
import type { ToolExecutionContext } from "./types.js";

/**
 * Tools run on behalf of a live call, not a logged-in user. The call (and so
 * the organization) is fixed when the conversation starts — the LLM can only
 * supply tool arguments, never an organization or lead id — so tool calls
 * use a system context scoped to that one organization.
 */
export function toolContext(ctx: ToolExecutionContext): RequestContext {
  return systemContext(ctx.organizationId, "ai-tool");
}
