import type { AiTool } from "./types.js";

/**
 * end_call is a pure control signal — it has no database side effect.
 * The conversation loop (modules/ai-agent) checks for this tool name
 * specifically and ends the call gracefully after speaking the model's
 * final response. Execution here just acknowledges the signal.
 */
export const endCall: AiTool = {
  definition: {
    name: "end_call",
    description: "End the call gracefully. Use after the conversation has reached a natural conclusion (booking confirmed, lead not interested, or lead wants to end the call).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute() {
    return { ended: true };
  },
};

export const END_CALL_TOOL_NAME = "end_call";
