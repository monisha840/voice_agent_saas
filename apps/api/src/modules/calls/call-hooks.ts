/**
 * Extension points the Voice AI core offers to optional modules.
 *
 * The call lifecycle (create, status changes, finalize, live conversation) is core and knows nothing about
 * leads, projects or site visits. A module that wants to take part registers a CallHooks object once at
 * startup (see modules/sales/index.ts); the core then calls the hooks that exist. With no hooks registered
 * every call is simply a call: no lead, no module context, nothing extra to update afterwards.
 */
import { or, type SQL } from "drizzle-orm";
import type { RequestContext } from "../../auth/context.js";
import type { PromptParams } from "../ai-agent/persona.js";
import type { callsRepository } from "../../db/repositories/calls.repository.js";
import type { AgentRow } from "../../db/repositories/agents.repository.js";

export type HookCall = NonNullable<Awaited<ReturnType<typeof callsRepository.findByIdAnyOrg>>>;
export type CallStatusEvent = "answered" | "busy" | "no_answer" | "failed";

/**
 * What a module knows about the "who/what" of a call, used to build the agent's prompt and tool context.
 * It is deliberately generic: the core does not know what a module's context means (a lead, a project, a
 * patient...), it only passes it on.
 */
export interface CallSubject {
  /** Ids this module attaches to the call; handed to the module's tools as ToolExecutionContext.subject. */
  context?: Record<string, string>;
  /** Names of the context requirements this call satisfies (a tool's `requires` is matched against these). */
  provides?: string[];
  /** The person on the other end, when the module knows who they are. */
  contactName?: string | null;
  /** Extra prompt parameters (e.g. the sales template's lead and project names). */
  promptParams?: Partial<PromptParams>;
}

/** Which calls a restricted viewer may see, as decided by a module: everything, or only rows matching a calls-table condition. */
export type CallVisibility = { kind: "all" } | { kind: "where"; condition: SQL };

/** The minimal call fields a module needs to attach its own data to a listed call. */
export interface ListedCallRef {
  id: string;
  leadId: string | null;
}

export interface CallHooks {
  readonly name: string;
  /** Pick the agent for a call attached to a lead when the caller did not choose one (null = no preference). */
  pickAgentForLead?(ctx: RequestContext, params: { leadId: string }): Promise<string | null>;
  /** Check a user may place a call to this lead (module enabled, permission, scope); returns who it is. */
  assertLeadCallable?(ctx: RequestContext, leadId: string): Promise<{ name: string; phone: string }>;
  /** Describe the call's subject for the live conversation. */
  resolveSubject?(ctx: RequestContext, call: HookCall, agent: AgentRow): Promise<CallSubject | null>;
  /** React to call progress (e.g. move a lead that was being dialed). */
  onStatus?(ctx: RequestContext, call: HookCall, event: CallStatusEvent): Promise<void>;
  /** React to a finalized call and its stored summary. */
  onFinalized?(ctx: RequestContext, call: HookCall, summary: unknown): Promise<void>;
  /**
   * Row visibility for this viewer (null = this module has no opinion). The condition may reference only the
   * `calls` table directly; anything else must be a correlated, organization-bound subquery.
   */
  callVisibility?(ctx: RequestContext): Promise<CallVisibility | null>;
  /** Extra fields to show on listed calls, keyed by call id. Must only read the ctx's own organization. */
  enrichListedCalls?(ctx: RequestContext, calls: ListedCallRef[]): Promise<Map<string, Record<string, unknown>>>;
  /** Match an inbound caller to a known contact; return its id only when the match is unambiguous. */
  findLeadByPhone?(ctx: RequestContext, phone: string): Promise<string | null>;
}

const registered = new Map<string, CallHooks>();

/** Idempotent: registering the same module name again replaces its hooks. */
export function registerCallHooks(hooks: CallHooks): void {
  registered.set(hooks.name, hooks);
}

export function unregisterCallHooks(name: string): void {
  registered.delete(name);
}

/** Test seam. */
export function clearCallHooks(): void {
  registered.clear();
}

export const callHooks = {
  async pickAgentForLead(ctx: RequestContext, params: { leadId: string }): Promise<string | null> {
    for (const h of registered.values()) {
      const id = await h.pickAgentForLead?.(ctx, params);
      if (id) return id;
    }
    return null;
  },
  async assertLeadCallable(ctx: RequestContext, leadId: string) {
    for (const h of registered.values()) {
      if (h.assertLeadCallable) return h.assertLeadCallable(ctx, leadId);
    }
    throw new Error("No module can place calls to leads");
  },
  async resolveSubject(ctx: RequestContext, call: HookCall, agent: AgentRow): Promise<CallSubject> {
    const merged: CallSubject = {};
    for (const h of registered.values()) {
      const s = await h.resolveSubject?.(ctx, call, agent);
      if (!s) continue;
      Object.assign(merged, s, {
        promptParams: { ...merged.promptParams, ...s.promptParams },
        context: { ...merged.context, ...s.context },
        provides: [...new Set([...(merged.provides ?? []), ...(s.provides ?? [])])],
      });
    }
    return merged;
  },
  async onStatus(ctx: RequestContext, call: HookCall, event: CallStatusEvent): Promise<void> {
    for (const h of registered.values()) await h.onStatus?.(ctx, call, event);
  },
  async onFinalized(ctx: RequestContext, call: HookCall, summary: unknown): Promise<void> {
    for (const h of registered.values()) await h.onFinalized?.(ctx, call, summary);
  },
  async callVisibility(ctx: RequestContext): Promise<CallVisibility | null> {
    const conditions: SQL[] = [];
    for (const h of registered.values()) {
      const v = await h.callVisibility?.(ctx);
      if (!v) continue;
      if (v.kind === "all") return v;
      conditions.push(v.condition);
    }
    if (conditions.length === 0) return null;
    return { kind: "where", condition: (conditions.length === 1 ? conditions[0] : or(...conditions)) as SQL };
  },
  async enrichListedCalls(ctx: RequestContext, calls: ListedCallRef[]): Promise<Map<string, Record<string, unknown>>> {
    const merged = new Map<string, Record<string, unknown>>();
    if (calls.length === 0) return merged;
    for (const h of registered.values()) {
      const extra = await h.enrichListedCalls?.(ctx, calls);
      if (!extra) continue;
      for (const [id, fields] of extra) merged.set(id, { ...merged.get(id), ...fields });
    }
    return merged;
  },
  async findLeadByPhone(ctx: RequestContext, phone: string): Promise<string | null> {
    for (const h of registered.values()) {
      const id = await h.findLeadByPhone?.(ctx, phone);
      if (id) return id;
    }
    return null;
  },
};
