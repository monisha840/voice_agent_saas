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
import { fallbackLine, fixedLine } from "./fallback-lines.js";
import { QuestionLimiter, questionsIn } from "./one-question.js";
import { announcesEndOfCall, isRepeat } from "./loop-guard.js";

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
  /**
   * The model judged the caller's words to be background talk, not addressed to it, and chose to say nothing: no reply is
   * spoken or recorded and the caller's words are taken back out of the conversation. `spokenText` is then empty.
   */
  silent?: boolean;
}

const MAX_TOOL_HOPS_PER_TURN = 4;

/** Replies that repeated an earlier one, in a row, after which the agent is told to change tack. */
const REPEAT_NOTE_AT = 1;
/** ...and after which it wraps the call up instead of going round again. */
const FORCE_CLOSE_AT = 3;
/** How many of its latest replies the agent compares a new one against. */
const REPEAT_WINDOW = 3;

/** The one word the model answers with when the caller's words were not meant for it (see the prompt). */
const SILENT_REPLY = /^\W*silent\W*$/i;
/** After this many silences in a row the next one is not trusted: a real caller must not be ignored indefinitely. */
const MAX_SILENCES_IN_ROW = 2;

export const isSilentReply = (text: string): boolean => SILENT_REPLY.test(text.trim());

const REPEAT_NOTE =
  "You have just repeated yourself. Do not say it again in any form, and do not repeat that you are an AI assistant or that you cannot hear. If the lead asked for something you cannot give, say so in one new sentence, say the team will follow up, and ask one different useful question. If there is nothing left to ask, offer a callback and close politely.";

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
  /** True when the caller explicitly asked for that language: the hint then overrides every earlier language instruction. */
  languageRequested?: boolean;
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

const QUESTION_SENTENCE = /[^.!?\n]*\?/g;
const MAX_REMEMBERED_QUESTIONS = 6;

/**
 * A short reminder of what the agent has already said, so it does not ask or say the same thing again. Built from the
 * history (nothing is stored), and only when there is something to remind of. Returns null before the agent has spoken.
 */
export function alreadySaidNote(messages: ChatMessage[]): string | null {
  const replies = messages.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) === 0 && m.content.trim() !== "");
  if (replies.length === 0) return null;
  const asked: string[] = [];
  for (const r of replies) {
    for (const q of r.content.match(QUESTION_SENTENCE) ?? []) {
      const t = q.trim();
      if (t.length >= 6 && !asked.includes(t)) asked.push(t);
    }
  }
  const lines = [
    `Do not repeat yourself. Your last reply was: "${replies[replies.length - 1].content.trim()}". Do not say it again word for word; if the caller asks you to repeat something, say it differently and more briefly.`,
  ];
  if (asked.length > 0) {
    const list = asked.slice(-MAX_REMEMBERED_QUESTIONS).map((q, i) => `${i + 1}. ${q}`).join("\n");
    lines.push(`Questions you have already asked (do not ask them again; use what the caller answered):\n${list}`);
  }
  return lines.join("\n");
}

const sameCall = (a: ToolCallRequest, b: ToolCallRequest) =>
  a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);

export class ConversationSession {
  private messages: ChatMessage[] = [];
  /** Every tool-call id used in this conversation, so ids stay unique even if a provider reuses them (e.g. "call_0"). */
  private readonly usedToolCallIds = new Set<string>();
  private toolCallSeq = 0;
  /** What the agent has said, latest last (bounded), to notice when it repeats itself. */
  private recentReplies: string[] = [];
  /** Replies in a row that repeated one of the last few. */
  private repeatStreak = 0;
  /** The call was about to end and the caller spoke again: the next request says so, once. */
  private resumedAfterClosing = false;
  /** Caller utterances in a row that the model chose not to answer. */
  private silentStreak = 0;

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

  /**
   * The agent had decided to end the call and the caller said something more, so the call goes on. The model's history
   * still shows end_call; the next request tells it the call is not ending.
   */
  noteCallContinues(): void {
    this.resumedAfterClosing = true;
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
    const undo = this.pushUserMessage(text);
    const result = await this.runTurn(opts);
    if (result.silent) {
      // Not addressed to the agent: it is not part of the conversation, in the model's history or in the record.
      undo();
      await conversationsRepository.removeLastTurnIf({ organizationId: this.toolCtx.organizationId, callId: this.toolCtx.callId, speaker: "lead", text });
    }
    return result;
  }

  /**
   * A user message. If the previous turn was cut short before the model answered (interrupted, cancelled or failed), its
   * user message is still the last one in the history; two consecutive user messages are not valid for every provider, so
   * the new words are added to it and the model answers both at once. (The transcript still records them as separate
   * caller turns.)
   */
  private pushUserMessage(text: string): () => void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") {
      const before = last.content;
      last.content = `${before}\n${text}`;
      // Takes the words back out again (they turned out not to be addressed to the agent).
      return () => {
        if (this.messages[this.messages.length - 1] === last) last.content = before;
      };
    }
    const added: ChatMessage = { role: "user", content: text };
    this.messages.push(added);
    return () => {
      if (this.messages[this.messages.length - 1] === added) this.messages.pop();
    };
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
    toolChoice?: "none",
  ): Promise<{ result: ChatResult; chunks?: string[] }> {
    const signal = opts?.signal;
    const observer = opts?.observer;
    const callOpts = { signal, callId: this.toolCtx.callId, ...(toolChoice ? { toolChoice } : {}) };
    const messages = this.messagesFor(opts, toolChoice === "none");
    observer?.onRequestStart?.(hop);

    if (!(this.options.streaming && this.llm.chatStream)) {
      const result = await this.llm.chat(messages, tools, callOpts);
      observer?.onHopComplete?.({ hop, toolCalls: result.toolCalls?.length ?? 0, chars: result.content?.length ?? 0, chunks: 0, streamed: false });
      return { result };
    }

    const chunker = new SentenceChunker();
    const questions = new QuestionLimiter(this.recentQuestions());
    const chunks: string[] = [];
    let sawToken = false;
    const emit = (raw: string) => {
      if (signal?.aborted) return;
      // The model chose silence: nothing is spoken.
      if (isSilentReply(raw)) return;
      // One question per reply: later questions are never spoken.
      const text = questions.filter(raw).text;
      if (!text) return;
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

  /**
   * The history as sent to the model: unchanged, plus one-turn notes that are never stored (what the agent has already
   * asked and said, and the caller's language when known).
   */
  private messagesFor(opts: TurnOptions | undefined, closing = false): ChatMessage[] {
    const out: ChatMessage[] = [...this.messages];
    const already = alreadySaidNote(this.messages);
    if (already) {
      // Just before the caller's latest words, so the history still ends exactly as it was said.
      let at = out.length;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === "user") {
          at = i;
          break;
        }
      }
      out.splice(at, 0, { role: "system", content: already });
    }
    const language = opts?.replyLanguage?.trim();
    if (language) {
      const content = opts?.languageRequested
        ? `The caller has asked you to speak ${language}. This overrides every earlier instruction about language: write your reply to the caller in ${language} only, and keep doing so until they ask for another language.`
        : `The caller is speaking ${language}. Write your reply to the caller in ${language}.`;
      out.push({ role: "system", content });
    }
    if (this.resumedAfterClosing && !closing) {
      out.push({
        role: "system",
        content:
          "The call was about to end but the caller has spoken again, so it is NOT ending. Answer what they said. Do not say goodbye unless they are finished, and do not say you had ended the call.",
      });
    }
    if (!closing && this.repeatStreak >= REPEAT_NOTE_AT) out.push({ role: "system", content: REPEAT_NOTE });
    // Once end_call has run, a model that sees it in the history takes the conversation as finished and says nothing;
    // it is told plainly that the reply is still wanted, and what it must contain.
    if (closing) {
      out.push({
        role: "system",
        content:
          "The call is about to end. Reply to the caller in words: say what was just done for them (for example the day and time of a booked visit, or that a team member will call them). Do not say goodbye, bye or thank you for your time: the line stays open a little longer in case the caller has more to say, and the goodbye is said afterwards. Do not call any tool.",
      });
    }
    return out;
  }

  private async runTurn(opts?: TurnOptions): Promise<ConversationTurnResult> {
    const tools = getToolDefinitions(this.allowedTools());
    let shouldEndCall = false;
    /** Words the model put inside the end_call request itself (some models say goodbye there instead of in the reply). */
    let endCallMessage: string | null = null;
    const signal = opts?.signal;

    // The conversation has gone round in circles: stop it here, politely, and leave the team a note.
    if (this.repeatStreak >= FORCE_CLOSE_AT) {
      shouldEndCall = true;
      await this.noteStalledCall();
    }

    for (let hop = 0; hop < MAX_TOOL_HOPS_PER_TURN; hop++) {
      if (signal?.aborted) throw new ConversationCancelledError();
      // After end_call has run the model must answer in words: letting it call tools again lets it loop on end_call.
      // The tools stay defined (providers refuse tool results in a request without tools); it is told to choose none.
      const { result, chunks } = await this.requestModel(tools, hop, opts, shouldEndCall ? "none" : undefined);

      // A provider that ignored tool_choice "none" and asked for tools anyway: they are not run (the call is ending),
      // and whatever words came with the request are the reply.
      if (!shouldEndCall && result.toolCalls && result.toolCalls.length > 0) {
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
            if (call.name === END_CALL_TOOL_NAME) {
              shouldEndCall = true;
              const said = (call.arguments as { message?: unknown } | null | undefined)?.message;
              if (typeof said === "string" && said.trim()) endCallMessage = said.trim();
            }
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

      // One question per reply: the history holds what the caller heard, so later questions are removed here too.
      // A call that is ending must not end in silence: if the model said no closing words, use the ones it put in
      // end_call, else a short fixed goodbye in the call's language.
      let reply = result.content ?? "";
      if (!shouldEndCall && isSilentReply(reply)) {
        if (this.silentStreak < MAX_SILENCES_IN_ROW) {
          this.silentStreak++;
          logger.info("ai-agent: the caller's words were judged background talk; no reply", { callId: this.toolCtx.callId, streak: this.silentStreak });
          return { spokenText: "", shouldEndCall: false, silent: true };
        }
        // Silent too many times in a row: this is probably a real caller. Ask them to repeat instead of ignoring them.
        reply = fixedLine("retry", opts?.replyLanguage ?? this.agent?.language);
      }
      this.silentStreak = 0;
      this.resumedAfterClosing = false;
      if (shouldEndCall && !reply.trim()) reply = endCallMessage ?? fixedLine("noted", opts?.replyLanguage ?? this.agent?.language);
      let limited = new QuestionLimiter(this.recentQuestions()).filter(reply);
      // If dropping a repeated question would leave nothing to say, the repeat is better than silence.
      if (!limited.text.trim() && reply.trim()) limited = new QuestionLimiter().filter(reply);
      if (limited.dropped) logger.info("ai-agent: extra questions dropped from the reply", { callId: this.toolCtx.callId });
      const spokenText = limited.text;
      // Saying the call is over is not enough to end it: if the reply announces it, the call really ends.
      if (!shouldEndCall && announcesEndOfCall(spokenText)) {
        shouldEndCall = true;
        logger.warn("ai-agent: reply announced the end of the call without end_call; ending it", { callId: this.toolCtx.callId });
      }
      this.repeatStreak = isRepeat(spokenText, this.recentReplies.slice(-REPEAT_WINDOW)) ? this.repeatStreak + 1 : 0;
      if (this.repeatStreak > 0) logger.info("ai-agent: reply repeats an earlier one", { callId: this.toolCtx.callId, streak: this.repeatStreak });
      this.recentReplies.push(spokenText);
      if (this.recentReplies.length > 2 * REPEAT_WINDOW) this.recentReplies.shift();
      this.messages.push({ role: "assistant", content: spokenText });
      await this.recordTurn("ai", spokenText);

      return { spokenText, shouldEndCall, ...(chunks ? { chunks } : {}) };
    }

    // Exceeded tool-hop budget — fail safe rather than looping forever.
    const fallback = fallbackLine(opts?.replyLanguage ?? this.agent?.language);
    await this.recordTurn("ai", fallback);
    return { spokenText: fallback, shouldEndCall: true };
  }

  /** The questions in the agent's last two replies: asking one of them again, word for word, is dropped. */
  private recentQuestions(): string[] {
    const replies = this.messages.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) === 0 && m.content.trim() !== "");
    return replies.slice(-2).flatMap((m) => questionsIn(m.content));
  }

  /** Leaves the team a callback note for a call that went nowhere. Never throws; a missing tool is simply skipped. */
  private async noteStalledCall(): Promise<void> {
    try {
      await this.runTool({
        id: `stalled_${++this.toolCallSeq}`,
        name: "request_follow_up",
        arguments: { reason: "callback", note: "The conversation stopped making progress and the agent ended the call. Please call the lead back." },
      });
    } catch {
      // a note for the team must never break the call
    }
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
