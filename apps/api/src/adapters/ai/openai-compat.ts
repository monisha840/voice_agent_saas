/**
 * Wire translation for OpenAI-style chat-completions endpoints (Sarvam today; any OpenAI-compatible provider later).
 * Provider-specific URLs, auth headers and model names stay in the adapter; the message and tool-call SHAPE lives here.
 *
 * The contract that matters: an assistant turn that calls tools is ONE message carrying `tool_calls` (id, name,
 * JSON-string arguments), and it must be followed by one `tool` message per call, each carrying the matching
 * `tool_call_id`. Endpoints reject, or silently mishandle, a `tool` message whose id no assistant message declared.
 */
import type { ChatMessage, ToolCallRequest, ToolDefinition } from "./llm.interface.js";

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export function toOpenAiMessage(msg: ChatMessage): OpenAiMessage {
  if (msg.role === "tool") {
    return { role: "tool", content: msg.content, tool_call_id: msg.toolCallId ?? "" };
  }
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content ? msg.content : null,
      tool_calls: msg.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    };
  }
  return { role: msg.role, content: msg.content };
}

export function toOpenAiTool(tool: ToolDefinition) {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/**
 * Reads `message.tool_calls` from a completion. Ids are preserved exactly as the provider sent them (an empty or
 * missing id is left empty: the conversation assigns a unique one). Arguments that are not a JSON object are flagged
 * with `invalidArguments` instead of being silently replaced by `{}`, so a tool is never run on guessed arguments.
 */
export function parseOpenAiToolCalls(rawToolCalls: Array<Record<string, unknown>>): ToolCallRequest[] {
  return rawToolCalls.map((tc) => {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    let invalid = false;
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else invalid = true;
      } catch {
        invalid = true;
      }
    } else if (rawArgs !== undefined && rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>; // some compatible servers return an object, not a string
    }
    return { id: typeof tc.id === "string" ? tc.id : "", name: String(fn.name ?? ""), arguments: args, ...(invalid ? { invalidArguments: true } : {}) };
  });
}

/**
 * Assembles tool calls from OpenAI-style STREAMING deltas (`delta.tool_calls[]` fragments carrying `index`, and `id`,
 * `function.name`, `function.arguments` pieces that concatenate). Provider-neutral, but note: whether a given provider
 * (Sarvam) streams tool calls exactly this way is NOT documented, so this follows the OpenAI-compatible convention and
 * is deliberately conservative:
 *   - nothing is exposed until `finish()`: a tool call is never acted on while it may still be incomplete;
 *   - a fragment is routed by `index`, or by `id` when the index is missing; a repeated id lands in the SAME slot, so
 *     a re-sent fragment cannot create a second call;
 *   - arguments that do not parse as a JSON object at the end are flagged `invalidArguments` (never guessed);
 *   - a call with no name is incomplete and makes `finish()` report it, so the caller can fail the stream.
 * Memory is bounded: at most MAX_SLOTS calls and MAX_ARGUMENT_CHARS of arguments per call.
 */
const MAX_SLOTS = 16;
const MAX_ARGUMENT_CHARS = 64 * 1024;

interface ToolSlot {
  id: string;
  name: string;
  args: string;
  argsObject?: Record<string, unknown>;
}

export class StreamingToolCalls {
  private slots: ToolSlot[] = [];
  private byIndex = new Map<number, ToolSlot>();

  get count(): number {
    return this.slots.length;
  }

  /** Feeds `delta.tool_calls`. Returns false if a limit was exceeded (the stream should fail). */
  push(fragments: unknown): boolean {
    if (!Array.isArray(fragments)) return true;
    for (const raw of fragments) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      const fn = (f.function ?? {}) as Record<string, unknown>;
      const id = typeof f.id === "string" ? f.id : "";
      const index = typeof f.index === "number" ? f.index : undefined;

      let slot: ToolSlot | undefined = index !== undefined ? this.byIndex.get(index) : undefined;
      if (!slot && id) slot = this.slots.find((s) => s.id === id);
      if (!slot && index === undefined && !id) slot = this.slots[this.slots.length - 1]; // a bare continuation
      if (!slot) {
        if (this.slots.length >= MAX_SLOTS) return false;
        slot = { id: "", name: "", args: "" };
        this.slots.push(slot);
      }
      if (index !== undefined) this.byIndex.set(index, slot);
      if (id && !slot.id) slot.id = id;
      if (typeof fn.name === "string" && fn.name) {
        if (!slot.name) slot.name = fn.name;
        else if (slot.name !== fn.name) slot.name += fn.name; // a name split across fragments
      }
      if (typeof fn.arguments === "string") {
        slot.args += fn.arguments;
        if (slot.args.length > MAX_ARGUMENT_CHARS) return false;
      } else if (fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)) {
        slot.argsObject = fn.arguments as Record<string, unknown>;
      }
    }
    return true;
  }

  /** The completed calls, or `incomplete: true` if any call never received a name. Call once, when the stream is over. */
  finish(): { calls: ToolCallRequest[]; incomplete: boolean } {
    if (this.slots.some((s) => !s.name)) return { calls: [], incomplete: true };
    const raw = this.slots.map((s) => ({
      id: s.id,
      function: { name: s.name, arguments: s.argsObject ?? s.args },
    }));
    return { calls: parseOpenAiToolCalls(raw), incomplete: false };
  }
}
