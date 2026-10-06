import type { ToolExecutionContext } from "../../../ai-tools/types.js";

/**
 * The lead and project the Sales module attached to this call (see sales-call-hooks.ts, resolveSubject).
 * The core's tool context knows nothing about them: it only carries the module-contributed ids as `subject`.
 */
export function salesSubject(ctx: ToolExecutionContext): { leadId?: string; projectId?: string } {
  return { leadId: ctx.subject?.leadId, projectId: ctx.subject?.projectId };
}
