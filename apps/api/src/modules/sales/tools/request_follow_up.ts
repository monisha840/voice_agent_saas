import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { followUpsService } from "../../follow-ups/follow-ups.service.js";
import { FOLLOW_UP_KINDS, type FollowUpKind } from "../../../db/repositories/follow-ups.repository.js";

interface Args {
  reason?: string;
  note?: string;
  callbackTime?: string;
}

/**
 * A time the model gave as ISO 8601, or null when it is missing, not parseable, not a date at all, or already past (a
 * model that does not know today's date guesses a year; the caller's own words are kept in the note instead).
 */
export function parseCallbackTime(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime()) || d.getTime() < now.getTime() - 60_000) return null;
  return d;
}

export const requestFollowUp: AiTool<Args> = {
  module: "sales",
  // A project on the call (the Sales context) is enough: an unknown caller has no lead yet but must still be able to ask for a person.
  requires: ["project"],
  definition: {
    name: "request_follow_up",
    description:
      "Tell the sales team something they must do after this call. reason is one of: human_requested (the lead asked to speak to a person, human, manager or sales executive), callback (the lead is busy right now and asked YOU to call them later or at a particular time; never use it when they ask about visiting or propose a time to visit), info_requested (the lead asked for something you could not give, e.g. a document or a detail that is not in the project data), do_not_call (the lead asked not to be called again). Put what the lead said in note, briefly. Only give callbackTime when the lead named a specific time.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: [...FOLLOW_UP_KINDS], description: "Why the team must follow up" },
        note: { type: "string", description: "One short sentence: what the lead asked for, in their words" },
        callbackTime: { type: "string", description: "ISO 8601 date-time with the +05:30 offset that the lead asked to be called at, worked out from the current time in the prompt; leave out if they gave none" },
      },
      required: ["reason"],
    },
  },
  async execute(args, ctx) {
    const kind = (FOLLOW_UP_KINDS as readonly string[]).includes(args.reason ?? "") ? (args.reason as FollowUpKind) : null;
    if (!kind) return { error: `reason must be one of: ${FOLLOW_UP_KINDS.join(", ")}` };
    const dueAt = parseCallbackTime(args.callbackTime);
    // A time the model gave in words ("after the 20th") is kept in the note, so the team still sees it.
    const spoken = !dueAt && typeof args.callbackTime === "string" && args.callbackTime.trim() ? `Time asked: ${args.callbackTime.trim()}` : "";
    const note = [typeof args.note === "string" ? args.note.trim() : "", spoken].filter(Boolean).join(". ").slice(0, 500) || null;
    const row = await followUpsService.record(toolContext(ctx), {
      leadId: salesSubject(ctx).leadId ?? null,
      callId: ctx.callId,
      kind,
      note,
      dueAt,
    });
    return { recorded: true, kind: row.kind };
  },
};
