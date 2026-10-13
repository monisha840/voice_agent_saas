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

import type { ILanguageModel, ChatMessage, ChatResult, ToolCallRequest, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { SentenceChunker } from "./text-chunker.js";
import { getToolDefinitions, executeTool, END_CALL_TOOL_NAME } from "../../ai-tools/index.js";
import type { ToolExecutionContext } from "../../ai-tools/index.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { buildSystemPrompt, type PromptParams } from "./persona.js";
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import { logger } from "../../shared/logger.js";
import { getConfig } from "../../config/env.js";

export interface ConversationTurnResult {
  /** The spoken text to synthesize via TTS and play to the lead. */
  spokenText: string;
  /**
   * The same reply split into speakable chunks (sentence-sized, see text-chunker.ts), when the model was streamed;
   * undefined for a batch reply. Joined with spaces it is `spokenText` up to whitespace.
   */
  chunks?: string[];
  /** True if the model signaled the call should end after this turn. */
  shouldEndCall: boolean;
}

const MAX_TOOL_HOPS_PER_TURN = 4;

/** A speakable piece of a streamed reply. Only the chunks of the FINAL hop (one that ends without tool calls) are the reply. */
export interface TextChunk {
  text: string;
  /** Which model request of this turn produced it (0 = the first; later hops follow tool results). */
  hop: number;
  /** Position within the hop. */
  index: number;
}

/** Timing/shape notifications for metrics. They carry no text. All optional; the session never depends on them. */
export interface LlmTurnObserver {
  /** A model request is about to be sent (once per hop). */
  onRequestStart?(hop: number): void;
  /** The first reply text of a hop arrived (streaming only). */
  onFirstToken?(hop: number): void;
  /** The first complete speakable chunk of a hop was produced (streaming only). */
  onFirstChunk?(hop: number): void;
  /** A hop finished: how many tool calls it asked for, and the size of what it said. */
  onHopComplete?(e: { hop: number; toolCalls: number; chars: number; chunks: number; streamed: boolean; finishReason?: string; completionTokens?: number }): void;
}

export interface TurnOptions {
  /** The call ended (or the caller gave up): stop the model call, run no further tools. */
  signal?: AbortSignal;
  /** Streaming only: called as each speakable chunk of the reply is completed. Must not throw. */
  onTextChunk?: (chunk: TextChunk) => void;
  observer?: LlmTurnObserver;
  /** Monitoring only: called after each tool ran. `booked` is true when the tool really booked a site visit. Must not throw. */
  onToolRun?: (e: { name: string; booked: boolean }) => void;
  /**
   * The language the caller is speaking now (a name, e.g. "Tamil"). The model is told to answer in it for THIS turn only:
   * the hint is added to the request and never stored, so the history stays exactly what was said.
   */
  replyLanguage?: string;
}

export interface ConversationSessionOptions {
  /** Use the model's streaming API (when it has one) and report chunks as they complete. Default: batch. */
  streaming?: boolean;
}

/** The turn was cut short because the call ended. Not a failure of the model or a tool. */
export class ConversationCancelledError extends Error {
  constructor() {
    super("The conversation turn was cancelled");
    this.name = "ConversationCancelledError";
  }
}

const sameCall = (a: ToolCallRequest, b: ToolCallRequest) =>
  a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);

export class ConversationSession {
  private messages: ChatMessage[] = [];
  /** Every tool-call id used in this conversation, so ids stay unique even if a provider reuses them (e.g. "call_0"). */
  private readonly usedToolCallIds = new Set<string>();
  private toolCallSeq = 0;

  constructor(
    private readonly llm: ILanguageModel,
    private readonly toolCtx: ToolExecutionContext,
    params: PromptParams,
    /** Optional per-organization/project agent configuration; absent = the built-in default agent. */
    private readonly agent?: ResolvedAgentConfig,
    private readonly options: ConversationSessionOptions = {},
  ) {
    this.messages.push({ role: "system", content: buildSystemPrompt(params, agent) });
  }

  /** Call once, before the first user utterance, to get the AI's opening line. */
  async start(opts?: TurnOptions): Promise<ConversationTurnResult> {
    this.messages.push({
      role: "user",
      content: "[Call connected. Begin the conversation with your introduction.]",
    });
    return this.runTurn(opts);
  }

  /** Call with each new transcribed lead utterance. */
  async handleUserUtterance(text: string, opts?: TurnOptions): Promise<ConversationTurnResult> {
    await this.recordTurn("lead", text);
    this.pushUserMessage(text);
    return this.runTurn(opts);
  }

  /**
   * A user message. If the previous turn was cut short before the model answered (interrupted, cancelled or failed), its
   * user message is still the last one in the history; two consecutive user messages are not valid for every provider, so
   * the new words are added to it and the model answers both at once. (The transcript still records them as separate
   * caller turns.)
   */
  private pushUserMessage(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") last.content = `${last.content}\n${text}`;
    else this.messages.push({ role: "user", content: text });
  }

  /**
   * The caller talked over the agent's reply. The model must not believe it said what the caller never heard: if the
   * last message is the finished reply, it is cut to `heardText` (what had been synthesized, an upper bound on what was
   * heard), or dropped when nothing was. Tool calls and results are real events and stay. No effect when the last
   * message is not a plain reply (e.g. the turn was interrupted before the model finished).
   */
  noteInterrupted(heardText: string): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant" || (last.toolCalls?.length ?? 0) > 0) return;
    const heard = heardText.trim();
    if (heard.length >= last.content.length) return;
    if (heard) last.content = heard;
    else this.messages.pop();
  }

  /**
   * The explicit tool allow-list for this session. With an agent it is always a list (an empty one allows only
   * end_call); only a session with no agent at all (a bare unit-test session) is unrestricted.
   */
  private allowedTools(): readonly string[] | undefined {
    if (!this.agent) return undefined;
    return this.agent.effectiveTools ?? (Array.isArray(this.agent.allowedTools) ? this.agent.allowedTools : []);
  }

  /**
   * Makes the tool calls of ONE model response safe to record and answer:
   *  - an exact repeat (same id, tool and arguments) within the response is dropped, so it runs once;
   *  - an empty id, or an id already used in this conversation, is replaced by a fresh unique one. We write the same id
   *    on the assistant message and on its tool result, so the pairing the model sees is always consistent.
   */
  private normalizeToolCalls(calls: ToolCallRequest[]): ToolCallRequest[] {
    const out: ToolCallRequest[] = [];
    const original = new Map<string, ToolCallRequest>();
    for (const call of calls) {
      const prior = call.id ? original.get(call.id) : undefined;
      if (prior && sameCall(prior, call)) {
        logger.warn("ai-agent: duplicate tool call in one response ignored", { tool: call.name, callId: this.toolCtx.callId });
        continue;
      }
      if (call.id) original.set(call.id, call);
      let id = call.id;
      while (!id || this.usedToolCallIds.has(id)) id = `call_${++this.toolCallSeq}`;
      this.usedToolCallIds.add(id);
      out.push({ ...call, id });
    }
    return out;
  }

  /** Runs one tool. Never throws, never runs on arguments the model garbled, and is bounded in time. */
  private async runTool(call: ToolCallRequest): Promise<unknown> {
    if (call.invalidArguments && call.name !== END_CALL_TOOL_NAME) {
      return { error: `The arguments for ${call.name} were not valid, so it was not run. Call it again with valid arguments.` };
    }
    const timeoutMs = getConfig().providers.toolTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => {
        logger.warn("ai-agent: tool timed out", { tool: call.name, toolCallId: call.id, timeoutMs, callId: this.toolCtx.callId });
        resolve({ error: `${call.name} did not finish in time. Its outcome is unknown, so do not repeat it.` });
      }, timeoutMs);
    });
    try {
      // executeTool catches its own errors and returns { error }; a tool that is still running when the timeout wins
      // cannot be cancelled, which is exactly why the model is told not to repeat it.
      return await Promise.race([executeTool(call.name, call.arguments, this.toolCtx, this.allowedTools()), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One model request. Batch: a single chat() call. Streaming: chatStream() with deltas grouped into chunks as they
   * arrive. Either way the result is the same ChatResult, and conversation history is only ever written from it, after
   * the request has completed: a cancelled or failed stream leaves no partial message behind.
   */
  private async requestModel(
    tools: ToolDefinition[],
    hop: number,
    opts?: TurnOptions,
  ): Promise<{ result: ChatResult; chunks?: string[] }> {
    const signal = opts?.signal;
    const observer = opts?.observer;
    const callOpts = { signal, callId: this.toolCtx.callId };
    const messages = this.messagesFor(opts);
    observer?.onRequestStart?.(hop);

    if (!(this.options.streaming && this.llm.chatStream)) {
      const result = await this.llm.chat(messages, tools, callOpts);
      observer?.onHopComplete?.({ hop, toolCalls: result.toolCalls?.length ?? 0, chars: result.content?.length ?? 0, chunks: 0, streamed: false });
      return { result };
    }

    const chunker = new SentenceChunker();
    const chunks: string[] = [];
    let sawToken = false;
    const emit = (text: string) => {
      if (signal?.aborted) return;
      if (chunks.length === 0) observer?.onFirstChunk?.(hop);
      chunks.push(text);
      try {
        opts?.onTextChunk?.({ text, hop, index: chunks.length - 1 });
      } catch (err) {
        logger.error("ai-agent: onTextChunk handler threw", { callId: this.toolCtx.callId, errorName: err instanceof Error ? err.name : "UnknownError" });
      }
    };
    const result = await this.llm.chatStream(
      messages,
      tools,
      {
        onTextDelta: (delta) => {
          if (signal?.aborted) return; // a cancelled turn produces nothing further
          if (!sawToken) {
            sawToken = true;
            observer?.onFirstToken?.(hop);
          }
          for (const c of chunker.push(delta)) emit(c);
        },
      },
      callOpts,
    );
    // The reply is complete (not cut short, not a tool request): release the tail as the last chunk. If the model asked
    // for tools instead, whatever it said first was a preamble that this session does not speak.
    const asksForTools = (result.toolCalls?.length ?? 0) > 0;
    if (!asksForTools) for (const c of chunker.flush()) emit(c);
    observer?.onHopComplete?.({
      hop,
      toolCalls: result.toolCalls?.length ?? 0,
      chars: result.content?.length ?? 0,
      chunks: chunks.length,
      streamed: true,
      finishReason: result.finishReason,
      completionTokens: result.usage?.completionTokens,
    });
    return { result, chunks };
  }

  /** The history as sent to the model: unchanged, plus a one-turn language hint when the caller's language is known. */
  private messagesFor(opts?: TurnOptions): ChatMessage[] {
    const language = opts?.replyLanguage?.trim();
    if (!language) return this.messages;
    return [
      ...this.messages,
      { role: "system", content: `The caller is speaking ${language}. Write your reply to the caller in ${language}.` },
    ];
  }

  private async runTurn(opts?: TurnOptions): Promise<ConversationTurnResult> {
    const tools = getToolDefinitions(this.allowedTools());
    let shouldEndCall = false;
    const signal = opts?.signal;

    for (let hop = 0; hop < MAX_TOOL_HOPS_PER_TURN; hop++) {
      if (signal?.aborted) throw new ConversationCancelledError();
      const { result, chunks } = await this.requestModel(tools, hop, opts);

      if (result.toolCalls && result.toolCalls.length > 0) {
        const calls = this.normalizeToolCalls(result.toolCalls);
        // ONE assistant message carries every call of this response; each is answered by a tool message with its id.
        // It is recorded BEFORE anything runs, and every call gets an answer even if the turn is cancelled part-way, so
        // the history is valid whatever happens next.
        this.messages.push({ role: "assistant", content: "", toolCalls: calls });

        for (const call of calls) {
          let toolResult: unknown;
          if (signal?.aborted) {
            toolResult = { error: "Not run: the call has ended." };
          } else {
            logger.info("ai-agent: tool call", { tool: call.name, toolCallId: call.id, callId: this.toolCtx.callId });
            if (call.name === END_CALL_TOOL_NAME) shouldEndCall = true;
            toolResult = await this.runTool(call);
            const booked = typeof toolResult === "object" && toolResult !== null && (toolResult as { booked?: unknown }).booked === true;
            try {
              opts?.onToolRun?.({ name: call.name, booked });
            } catch {
              // monitoring must never affect the conversation
            }
          }
          this.messages.push({ role: "tool", content: JSON.stringify(toolResult), toolCallId: call.id });
        }
        if (signal?.aborted) throw new ConversationCancelledError();
        // Loop again so the model can respond to the tool result(s).
        continue;
      }

      const spokenText = result.content ?? "";
      this.messages.push({ role: "assistant", content: spokenText });
      await this.recordTurn("ai", spokenText);

      return { spokenText, shouldEndCall, ...(chunks ? { chunks } : {}) };
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
