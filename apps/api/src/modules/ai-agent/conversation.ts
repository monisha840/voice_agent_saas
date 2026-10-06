/**
 * ConversationSession — the turn-based orchestration loop:
 *
 *   user utterance text
 *     -> LLM.chat(messages, tools)
 *     -> either spoken text, or a tool call
 *     -> if tool call: executeTool() -> tool result fed back to LLM -> repeat
 *     -> spoken text returned to caller for TTS
 *
 * This class has NO knowledge of Exotel, WebSockets, or audio framing —
 * it only deals in text turns, so it can be unit-tested directly and
 * reused unchanged by the real media-stream handler (Phase 5) or by a
 * text-only test harness (Phase 4).
 *
 * Every turn is appended to an in-memory log AND persisted incrementally
 * via the conversations repository, so a dropped call does not lose the
 * whole transcript.
 */

import type { ILanguageModel, ChatMessage } from "../../adapters/ai/llm.interface.js";
import { getToolDefinitions, executeTool, END_CALL_TOOL_NAME } from "../../ai-tools/index.js";
import type { ToolExecutionContext } from "../../ai-tools/index.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { buildSystemPrompt, type PromptParams } from "./persona.js";
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import { logger } from "../../shared/logger.js";

export interface ConversationTurnResult {
  /** The spoken text to synthesize via TTS and play to the lead. */
  spokenText: string;
  /** True if the model signaled the call should end after this turn. */
  shouldEndCall: boolean;
}

const MAX_TOOL_HOPS_PER_TURN = 4;

export class ConversationSession {
  private messages: ChatMessage[] = [];

  constructor(
    private readonly llm: ILanguageModel,
    private readonly toolCtx: ToolExecutionContext,
    params: PromptParams,
    /** Optional per-organization/project agent configuration; absent = the built-in default agent. */
    private readonly agent?: ResolvedAgentConfig,
  ) {
    this.messages.push({ role: "system", content: buildSystemPrompt(params, agent) });
  }

  /** Call once, before the first user utterance, to get the AI's opening line. */
  async start(): Promise<ConversationTurnResult> {
    this.messages.push({
      role: "user",
      content: "[Call connected. Begin the conversation with your introduction.]",
    });
    return this.runTurn();
  }

  /** Call with each new transcribed lead utterance. */
  async handleUserUtterance(text: string): Promise<ConversationTurnResult> {
    await this.recordTurn("lead", text);
    this.messages.push({ role: "user", content: text });
    return this.runTurn();
  }

  /**
   * The explicit tool allow-list for this session. With an agent it is always a list (an empty one allows only
   * end_call); only a session with no agent at all (a bare unit-test session) is unrestricted.
   */
  private allowedTools(): readonly string[] | undefined {
    if (!this.agent) return undefined;
    return this.agent.effectiveTools ?? (Array.isArray(this.agent.allowedTools) ? this.agent.allowedTools : []);
  }

  private async runTurn(): Promise<ConversationTurnResult> {
    const tools = getToolDefinitions(this.allowedTools());
    let shouldEndCall = false;

    for (let hop = 0; hop < MAX_TOOL_HOPS_PER_TURN; hop++) {
      const result = await this.llm.chat(this.messages, tools);

      if (result.toolCalls && result.toolCalls.length > 0) {
        for (const call of result.toolCalls) {
          logger.info("ai-agent: tool call", { tool: call.name, callId: this.toolCtx.callId });

          if (call.name === END_CALL_TOOL_NAME) {
            shouldEndCall = true;
          }

          const toolResult = await executeTool(call.name, call.arguments, this.toolCtx, this.allowedTools());

          this.messages.push({
            role: "assistant",
            content: "",
            toolCallId: call.id,
            toolName: call.name,
          });
          this.messages.push({
            role: "tool",
            content: JSON.stringify(toolResult),
            toolCallId: call.id,
          });
        }
        // Loop again so the model can respond to the tool result(s).
        continue;
      }

      const spokenText = result.content ?? "";
      this.messages.push({ role: "assistant", content: spokenText });
      await this.recordTurn("ai", spokenText);

      return { spokenText, shouldEndCall };
    }

    // Exceeded tool-hop budget — fail safe rather than looping forever.
    const fallback = "Sorry, let me have a colleague follow up with you on that.";
    await this.recordTurn("ai", fallback);
    return { spokenText: fallback, shouldEndCall: true };
  }

  private async recordTurn(speaker: "ai" | "lead", text: string) {
    if (!text) return;
    await conversationsRepository.appendTurn({
      organizationId: this.toolCtx.organizationId,
      callId: this.toolCtx.callId,
      turn: { speaker, text, timestamp: new Date().toISOString() },
    });
  }
}
