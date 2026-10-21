/**
 * Agent test playground: a TEXT conversation with a saved agent through the real engine.
 *
 *   saved agent -> test call record (callsService.createCall, callType "test": quota-checked, never dialed, never
 *   billed) -> callRuntime.build (the same runtime a phone call gets: prompt, language, tools, knowledge) ->
 *   ConversationSession (the same conversation loop, tools and guards) with the configured LLM provider.
 *
 * Only speech is absent: the user types instead of talking, and replies are shown instead of spoken. Every tool call
 * the model makes (including search_knowledge) and its result are recorded and returned, so a user can see why the
 * agent answered as it did. Sessions live in this process's memory (idle timeout); the call record is completed when
 * the session ends or expires.
 */
import { z } from "zod";
import { assertCan } from "../../auth/access.js";
import { systemContext, type RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { getLlmProvider } from "../../adapters/ai/index.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import type { ProviderCallOptions } from "../../adapters/ai/provider-common.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { runInTenant } from "../../db/tenant-context.js";
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { parseInput } from "../../shared/validation.js";
import { ConversationSession, type ConversationTurnResult } from "../ai-agent/conversation.js";
import { callRuntime } from "../calls/call-runtime.js";
import { callsService } from "../calls/calls.service.js";

const IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_SESSIONS = 100;
const MAX_SESSIONS_PER_USER = 3;
const MAX_TURNS = 40;

export type PlaygroundEvent =
  | { type: "agent"; text: string; endsCall: boolean }
  | { type: "caller"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "ended"; reason: string };

/** Wraps the LLM to observe tool calls and their results without changing the engine. */
class RecordingLlm implements ILanguageModel {
  readonly name: string;
  readonly capabilities: ILanguageModel["capabilities"];
  events: PlaygroundEvent[] = [];
  private seenToolResults = new Set<string>();
  private toolNames = new Map<string, string>();
  constructor(private readonly inner: ILanguageModel) {
    this.name = inner.name;
    this.capabilities = inner.capabilities;
  }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult> {
    // The session renames provider tool-call ids; learn the names from the assistant messages it sends back.
    for (const m of messages) for (const c of m.toolCalls ?? []) if (c.id) this.toolNames.set(c.id, c.name);
    for (const m of messages) {
      if (m.role !== "tool" || !m.toolCallId || this.seenToolResults.has(m.toolCallId)) continue;
      this.seenToolResults.add(m.toolCallId);
      let result: unknown = m.content;
      try {
        result = JSON.parse(m.content);
      } catch {
        /* keep as text */
      }
      this.events.push({ type: "tool_result", name: this.toolNames.get(m.toolCallId) ?? m.toolName ?? "tool", result });
    }
    const res = await this.inner.chat(messages, tools, opts);
    for (const c of res.toolCalls ?? []) {
      if (c.id) this.toolNames.set(c.id, c.name);
      this.events.push({ type: "tool_call", name: c.name, arguments: c.arguments ?? {} });
    }
    return res;
  }
  take(): PlaygroundEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

interface Session {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  session: ConversationSession;
  llm: RecordingLlm;
  turns: number;
  lastUsed: number;
  ending: boolean;
}

const sessions = new Map<string, Session>();
let llmFactory: () => ILanguageModel = getLlmProvider;

/** Test seam: the LLM the playground uses (default: the configured provider, exactly like a phone call). */
export function setPlaygroundLlmFactory(factory: (() => ILanguageModel) | null): void {
  llmFactory = factory ?? getLlmProvider;
}

async function closeCall(s: Session, reason: string) {
  sessions.delete(s.id);
  try {
    await callsService.endFromStream({ callId: s.id, outcome: "completed" });
  } catch (err) {
    logger.warn("playground: could not complete the test call", { callId: s.id, reason, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Ends sessions idle for longer than the timeout (their test calls are completed). */
export async function sweepPlaygroundSessions(now = Date.now()): Promise<number> {
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (now - s.lastUsed > IDLE_TIMEOUT_MS) {
      n++;
      await closeCall(s, "idle");
    }
  }
  return n;
}

function ownSession(ctx: RequestContext, sessionId: string): Session {
  const s = z.string().uuid().safeParse(sessionId).success ? sessions.get(sessionId) : undefined;
  // Another user's (or organization's) session is indistinguishable from a missing one.
  if (!s || s.organizationId !== ctx.organizationId || ctx.actor.type !== "user" || s.userId !== ctx.actor.userId) {
    throw new NotFoundError("Playground session not found or expired");
  }
  return s;
}

function turnEvents(s: Session, turn: ConversationTurnResult | null, error?: unknown): PlaygroundEvent[] {
  const events = s.llm.take();
  if (error) events.push({ type: "error", message: error instanceof Error ? error.message : "The agent could not reply" });
  if (turn && !turn.silent && turn.spokenText.trim()) events.push({ type: "agent", text: turn.spokenText, endsCall: turn.shouldEndCall });
  return events;
}

const messageBody = z.object({ text: z.string().trim().min(1).max(500) }).strict();
const startBody = z.object({}).strict();

const playgroundServiceImpl = {
  async start(ctx: RequestContext, agentId: string, input: unknown) {
    assertCan(ctx, "agents:read");
    assertCan(ctx, "calls:create");
    parseInput(startBody, input ?? {});
    if (ctx.actor.type !== "user") throw new ValidationError("The playground is for signed-in users");
    const userId = ctx.actor.userId;
    await sweepPlaygroundSessions();
    if ([...sessions.values()].filter((s) => s.userId === userId).length >= MAX_SESSIONS_PER_USER) {
      throw new ConflictError(`You already have ${MAX_SESSIONS_PER_USER} open test conversations. End one first.`);
    }
    if (sessions.size >= MAX_SESSIONS) throw new ServiceUnavailableError("Too many test conversations are open. Try again shortly.", "NOT_READY");

    // A real test-call record: the agent must be an active agent of this organization, and plan limits apply.
    const call = await callsService.createCall(ctx, { agentId, callType: "test" });
    await callsService.markAnsweredFromStream({ callId: call.id });
    const row = await runInTenant({ organizationId: ctx.organizationId }, async () => callsRepository.findById({ organizationId: ctx.organizationId, id: call.id }));
    if (!row) throw new NotFoundError("Test call not found");
    const runtime = await callRuntime.build(systemContext(ctx.organizationId, "simulator"), row);
    const llm = new RecordingLlm(llmFactory());
    const session = new ConversationSession(llm, runtime.toolContext, runtime.promptParams, runtime.config, { streaming: false });
    const s: Session = { id: call.id, organizationId: ctx.organizationId, userId, agentId: runtime.agent.id, session, llm, turns: 0, lastUsed: Date.now(), ending: false };
    sessions.set(s.id, s);

    let opening: ConversationTurnResult | null = null;
    let error: unknown;
    try {
      opening = await session.start();
    } catch (err) {
      error = err;
    }
    const events = turnEvents(s, opening, error);
    if (opening?.shouldEndCall) {
      events.push({ type: "ended", reason: "The agent ended the conversation" });
      await closeCall(s, "agent-ended");
    }
    return {
      sessionId: s.id,
      simulated: true as const,
      agent: { id: runtime.agent.id, name: runtime.agent.name, personaName: runtime.agent.personaName, language: runtime.agent.language },
      effectiveTools: runtime.effectiveTools,
      events,
      ended: opening?.shouldEndCall === true,
    };
  },

  async message(ctx: RequestContext, sessionId: string, input: unknown) {
    const { text } = parseInput(messageBody, input);
    const s = ownSession(ctx, sessionId);
    if (s.ending) throw new ConflictError("This conversation is ending");
    if (s.turns >= MAX_TURNS) throw new ConflictError(`A test conversation is limited to ${MAX_TURNS} messages. Start a new one.`);
    s.turns++;
    s.lastUsed = Date.now();
    const events: PlaygroundEvent[] = [{ type: "caller", text }];
    let turn: ConversationTurnResult | null = null;
    let error: unknown;
    try {
      turn = await s.session.handleUserUtterance(text);
    } catch (err) {
      error = err;
      logger.warn("playground: turn failed", { callId: s.id, error: err instanceof Error ? err.message : String(err) });
    }
    events.push(...turnEvents(s, turn, error));
    const ended = turn?.shouldEndCall === true;
    if (ended) {
      s.ending = true;
      events.push({ type: "ended", reason: "The agent ended the conversation" });
      await closeCall(s, "agent-ended");
    }
    return { sessionId: s.id, events, ended };
  },

  async end(ctx: RequestContext, sessionId: string) {
    const s = ownSession(ctx, sessionId);
    s.ending = true;
    await closeCall(s, "user-ended");
    return { sessionId: s.id, ended: true };
  },
};

export const playgroundService = tenantScoped(playgroundServiceImpl);

/** Test helper: how many sessions are open. */
export function openPlaygroundSessions(): number {
  return sessions.size;
}

const sweeper = setInterval(() => void sweepPlaygroundSessions().catch(() => undefined), 60_000);
sweeper.unref();
