/**
 * Mock LLM — deterministic, rule-based "model" used for local dev and
 * automated tests without Sarvam credentials. It is intentionally
 * simple: it inspects the latest user/tool message and returns either
 * a canned tool call or a canned spoken response, so the surrounding
 * orchestration (tool execution, transcript persistence, post-call
 * summary) can be exercised end-to-end without a real LLM.
 *
 * This is NOT a simulation of a successful real call — see
 * ai-tools tests and conversation-loop tests, which label results
 * accordingly.
 */
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "./llm.interface.js";

export class MockLlmProvider implements ILanguageModel {
  readonly name = "mock-llm";

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastTool = [...messages].reverse().find((m) => m.role === "tool");
    const hasTool = (toolName: string) => tools.some((t) => t.name === toolName);

    // After a tool result comes back, respond with text referencing it.
    if (lastTool) {
      return { content: `Noted. (mock response following tool result: ${lastTool.content.slice(0, 80)})` };
    }

    const text = (lastUser?.content ?? "").toLowerCase();

    if (text.includes("price") && hasTool("get_project_price")) {
      return {
        toolCalls: [{ id: "mock-1", name: "get_project_price", arguments: { configuration: "2 BHK" } }],
      };
    }

    if (text.includes("visit") && hasTool("check_visit_slots")) {
      return { toolCalls: [{ id: "mock-2", name: "check_visit_slots", arguments: {} }] };
    }

    return { content: "Hello! This is a mock AI response for local development/testing." };
  }
}
