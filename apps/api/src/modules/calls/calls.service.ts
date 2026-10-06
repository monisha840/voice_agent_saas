import type { SQL } from "drizzle-orm";
import { callsRepository, ownCallsVisibility, type CallType } from "../../db/repositories/calls.repository.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { agentPhoneNumbersRepository } from "../../db/repositories/agent-phone-numbers.repository.js";
import { getLlmProvider } from "../../adapters/ai/index.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import { MockTelephonyProvider } from "../../adapters/telephony/mock.provider.js";
import type { ITelephonyProvider } from "../../adapters/telephony/telephony.interface.js";
import { generateCallSummary, legacyDefaultSummaryProfile, type SummaryProfile } from "../ai-agent/post-call-summary.js";
import { getPromptTemplate } from "../ai-agent/persona.js";
import { logger } from "../../shared/logger.js";
import { usageService } from "../usage/usage.service.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import { normalizeIndianMobile } from "../../shared/phone.js";
import { systemContext, type RequestContext } from "../../auth/context.js";
import { assertCan } from "../../auth/access.js";
import { auditService } from "../audit/audit.service.js";
import { callHooks } from "./call-hooks.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";

type ProviderCallStatus = "ringing" | "in_progress" | "completed" | "busy" | "no_answer" | "failed";
const TERMINAL_PROVIDER_STATUSES: ProviderCallStatus[] = ["completed", "busy", "no_answer", "failed"];
interface ProviderStatusUpdate {
  providerCallId: string;
  status: ProviderCallStatus;
  durationSeconds?: number;
  recordingUrl?: string;
}
type CallRow = NonNullable<Awaited<ReturnType<typeof callsRepository.findByIdAnyOrg>>>;
type CallStatusValue = Parameters<typeof callsRepository.list>[0]["status"];
const NON_TERMINAL_RANK: Record<string, number> = { initiating: 0, ringing: 1, in_progress: 2 };

export interface CreateCallInput {
  /** The agent that handles the call. Omitted: the lead's project agent (Sales), else the organization default. */
  agentId?: string;
  /** Optional: only calls made through the Sales module have a lead. */
  leadId?: string | null;
  callType?: CallType;
  counterpartyNumber?: string | null;
  counterpartyName?: string | null;
}

export interface PlaceCallInput {
  agentId: string;
  callType: "outbound" | "test";
  /** Whom to call. Not needed for a simulated test call. */
  toNumber?: string;
  leadId?: string;
}

/**
 * Which calls this viewer may see, as SQL. Owners, admins and system flows see the whole organization. A module
 * (Sales) may supply the rule for restricted viewers; with none registered, a manager sees calls that have no
 * association plus their own, and anyone else sees only the calls they started.
 */
async function callVisibilityFor(ctx: RequestContext): Promise<SQL | undefined> {
  const actor = ctx.actor;
  if (actor.type === "system" || actor.role === "OWNER" || actor.role === "ADMIN") return undefined;
  const fromModules = await callHooks.callVisibility(ctx);
  if (fromModules) return fromModules.kind === "all" ? undefined : fromModules.condition;
  return ownCallsVisibility({ userId: actor.userId, includeUnassociated: actor.role === "MANAGER" });
}

/** Strict E.164 when it is an Indian mobile we can normalize, otherwise the trimmed digits as given. */
function normalizeNumber(input: string): string {
  try {
    return normalizeIndianMobile(input);
  } catch {
    const cleaned = input.replace(/[\s()-]/g, "");
    if (!/^\+?[0-9]{6,20}$/.test(cleaned)) throw new ValidationError("Invalid phone number");
    return cleaned;
  }
}

/**
 * Service boundary for call data and the post-call pipeline. The live call orchestration (telephony +
 * STT/LLM/TTS loop) is driven from the websocket handler, but it calls back into this service to create the
 * call record, start the conversation record, and finalize everything once the call ends.
 *
 * A call belongs to an AGENT; a lead is optional and only ever reached through the call hooks that the Sales
 * module registers (modules/calls/call-hooks.ts), so this file knows nothing about leads or projects.
 *
 * Two kinds of methods:
 *  - user-facing (createCall, placeCall, getCallDetail, ...) take the request context and are confined to the
 *    caller's organization;
 *  - system flows (provider webhook, media-stream, inbound routing, reaper) start from a provider-supplied
 *    identifier with no login. They load the call "any org", then derive a system context from the CALL'S OWN
 *    organization, so everything downstream stays inside that one tenant.
 */
export const callsService = {
  async getCallDetail(ctx: RequestContext, params: { callId: string }) {
    assertCan(ctx, "calls:read");
    const org = ctx.organizationId;
    const call = await callsRepository.findByIdVisible({ organizationId: org, id: params.callId, visibility: await callVisibilityFor(ctx) });
    if (!call) return null;
    const [conversation, agent] = await Promise.all([
      conversationsRepository.findByCallId({ organizationId: org, callId: params.callId }),
      call.agentId ? agentsRepository.findById({ organizationId: org, id: call.agentId }) : Promise.resolve(null),
    ]);
    return {
      ...call,
      conversation,
      agent: agent ? { id: agent.id, name: agent.name, personaName: agent.personaName } : null,
    };
  },

  /** Newest-first page of the caller's calls (core Voice AI view: no lead or module data required). */
  async listCalls(
    ctx: RequestContext,
    params: { limit: number; before?: Date; status?: CallStatusValue; agentId?: string; callType?: CallType },
  ) {
    assertCan(ctx, "calls:read");
    const rows = await callsRepository.list({
      organizationId: ctx.organizationId,
      visibility: await callVisibilityFor(ctx),
      status: params.status,
      agentId: params.agentId,
      callType: params.callType,
      before: params.before,
      limit: params.limit + 1,
    });
    const page = rows.slice(0, params.limit);
    // Modules attach their own fields (the Sales module adds leadName / leadPhone); with none registered there are none.
    const extra = await callHooks.enrichListedCalls(ctx, page);
    const data = page.map((row) => ({ ...row, ...extra.get(row.id) }));
    return { data, nextBefore: rows.length > params.limit ? data[data.length - 1].createdAt.toISOString() : null };
  },

  /** Creates the call record (and its empty conversation). The agent must be an active agent of this organization. */
  async createCall(ctx: RequestContext, params: CreateCallInput) {
    assertCan(ctx, "calls:create");
    const org = ctx.organizationId;
    if (params.leadId) {
      // Module-owned check: module enabled, permission, and the lead is in this organization and the caller's scope.
      await callHooks.assertLeadCallable(ctx, params.leadId);
    }
    const agentId = await this.resolveAgentId(ctx, params);
    const call = await callsRepository.create({
      organizationId: org,
      agentId,
      leadId: params.leadId ?? null,
      callType: params.callType ?? "outbound",
      counterpartyNumber: params.counterpartyNumber ?? null,
      counterpartyName: params.counterpartyName ?? null,
      initiatedByUserId: ctx.actor.type === "user" ? ctx.actor.userId : null,
      status: "initiating",
    });
    await conversationsRepository.createForCall({ organizationId: org, callId: call.id });
    return call;
  },

  /** Explicit agent (must be active, same organization) > the lead's project agent (Sales) > the organization default. */
  async resolveAgentId(ctx: RequestContext, params: Pick<CreateCallInput, "agentId" | "leadId">): Promise<string> {
    const org = ctx.organizationId;
    if (params.agentId) {
      const agent = await agentsRepository.findById({ organizationId: org, id: params.agentId });
      if (!agent || agent.status !== "active") throw new NotFoundError(`Agent ${params.agentId} not found`);
      return agent.id;
    }
    if (params.leadId) {
      const picked = await callHooks.pickAgentForLead(ctx, { leadId: params.leadId });
      if (picked) return picked;
    }
    const fallback = await agentsRepository.findDefault({ organizationId: org });
    if (!fallback) throw new ValidationError("This organization has no active agent; create one first");
    return fallback.id;
  },

  /**
   * Places a call through the telephony provider: outbound (to a number, or to a lead via the Sales module) or a
   * test call. A test call without a number is a simulated call on the mock provider, whatever the environment's
   * telephony provider is, so nothing real is ever dialed by accident.
   */
  async placeCall(ctx: RequestContext, input: PlaceCallInput) {
    assertCan(ctx, "calls:create");
    let toNumber: string | null = null;
    let counterpartyName: string | null = null;
    if (input.leadId) {
      const lead = await callHooks.assertLeadCallable(ctx, input.leadId);
      toNumber = normalizeNumber(lead.phone);
      counterpartyName = lead.name;
    } else if (input.toNumber?.trim()) {
      toNumber = normalizeNumber(input.toNumber);
    } else if (input.callType === "outbound") {
      throw new ValidationError("A phone number or a lead is required for an outbound call");
    }

    const call = await this.createCall(ctx, {
      agentId: input.agentId,
      leadId: input.leadId,
      callType: input.callType,
      counterpartyNumber: toNumber,
      counterpartyName,
    });

    const simulated = input.callType === "test" && !toNumber;
    const provider: ITelephonyProvider = simulated ? simulationProvider() : getTelephonyProvider();
    try {
      const result = await provider.initiateCall({ toNumber: toNumber ?? SIMULATED_NUMBER, internalCallId: call.id });
      await this.attachProviderCallId(ctx, { callId: call.id, providerCallId: result.providerCallId });
      await auditService.record(ctx, {
        action: "call.initiated",
        entityType: "call",
        entityId: call.id,
        metadata: { callId: call.id, agentId: call.agentId, callType: call.callType, leadId: input.leadId ?? null, provider: provider.name },
      });
      return { callId: call.id, providerCallId: result.providerCallId, status: result.status, provider: provider.name, callType: call.callType };
    } catch (err) {
      await this.markFailed(ctx, { callId: call.id }).catch(() => undefined);
      throw err;
    }
  },

  /**
   * SYSTEM (provider-agnostic inbound entry point): a call arrived on `dialedNumber` from `callerNumber`. The
   * dialed number decides the agent; the Sales module (if on) may recognise the caller as an existing lead.
   * An unknown number, or a number whose agent is archived, is refused and creates nothing.
   */
  async startInboundCall(params: { dialedNumber: string; callerNumber?: string | null; providerCallId?: string | null }) {
    const route = await agentPhoneNumbersRepository.findByNumberAnyOrg({ phoneNumber: normalizeNumber(params.dialedNumber) });
    if (!route) throw new NotFoundError(`No agent answers ${params.dialedNumber}`);
    const agent = await agentsRepository.findById({ organizationId: route.organizationId, id: route.agentId });
    if (!agent || agent.status !== "active") throw new NotFoundError(`No active agent answers ${params.dialedNumber}`);

    const ctx = systemContext(route.organizationId, "telephony-inbound");
    const caller = params.callerNumber?.trim() ? normalizeNumber(params.callerNumber) : null;
    const leadId = caller ? await callHooks.findLeadByPhone(ctx, caller) : null;
    const call = await callsRepository.create({
      organizationId: route.organizationId,
      agentId: agent.id,
      leadId,
      callType: "inbound",
      status: "ringing",
      providerCallId: params.providerCallId ?? null,
      counterpartyNumber: caller,
    });
    await conversationsRepository.createForCall({ organizationId: route.organizationId, callId: call.id });
    await auditService.record(ctx, {
      action: "call.received",
      entityType: "call",
      entityId: call.id,
      metadata: { callId: call.id, agentId: agent.id, leadId },
    });
    return call;
  },

  async attachProviderCallId(ctx: RequestContext, params: { callId: string; providerCallId: string }) {
    assertCan(ctx, "calls:create");
    return callsRepository.setProviderCallId({
      organizationId: ctx.organizationId,
      id: params.callId,
      providerCallId: params.providerCallId,
    });
  },

  async markFailed(ctx: RequestContext, params: { callId: string }) {
    assertCan(ctx, "calls:create");
    return callsRepository.updateStatus({
      organizationId: ctx.organizationId,
      id: params.callId,
      status: "failed",
      endedAt: new Date(),
    });
  },

  /** SYSTEM: resolve a call from Exotel's call_sid (globally unique). Returns the row incl. its organizationId. */
  async getCallByProviderCallId(params: { providerCallId: string }) {
    return callsRepository.findByProviderCallIdAnyOrg(params);
  },

  /** SYSTEM: resolve a call from our own id (e.g. the media-stream URL) when the organization is not known yet. */
  async getCallByIdSystem(params: { callId: string }) {
    return callsRepository.findByIdAnyOrg({ id: params.callId });
  },

  /** SYSTEM (provider webhook): applies a status change; the organization comes from the call itself. */
  async applyProviderStatus(params: ProviderStatusUpdate): Promise<{ call: CallRow | null; finalizeCallId?: string }> {
    const call = await callsRepository.findByProviderCallIdAnyOrg({ providerCallId: params.providerCallId });
    if (!call) {
      logger.warn("calls.service: status callback for unknown providerCallId", {
        providerCallId: params.providerCallId,
      });
      return { call: null };
    }
    const ctx = systemContext(call.organizationId, "exotel-webhook");
    const org = ctx.organizationId;

    const isTerminal = TERMINAL_PROVIDER_STATUSES.includes(params.status);
    if (!isTerminal) {
      // Never regress a call (e.g. a late "ringing" after "in_progress"),
      // and never touch one that already ended.
      if (call.status === "completed" || call.status === "failed") return { call };
      if (NON_TERMINAL_RANK[params.status] <= NON_TERMINAL_RANK[call.status]) return { call };
      const updated = await callsRepository.updateStatus({
        organizationId: org,
        id: call.id,
        status: params.status as "ringing" | "in_progress",
        startedAt: params.status === "in_progress" && !call.startedAt ? new Date() : undefined,
      });
      if (params.status === "in_progress") await callHooks.onStatus(ctx, call, "answered");
      return { call: updated };
    }

    // busy / no_answer / failed all end the call as "failed" at the call level (the calls table has no finer
    // enum); the distinction is passed to modules, which may track it (the Sales module keeps it on the lead).
    const callStatus = params.status === "completed" ? "completed" : "failed";
    const updated = await callsRepository.transitionToTerminal({
      organizationId: org,
      id: call.id,
      status: callStatus,
      endedAt: new Date(),
      recordingUrl: params.recordingUrl,
    });
    if (!updated) {
      logger.info("calls.service: duplicate terminal callback ignored", {
        callId: call.id,
        status: params.status,
      });
      return { call };
    }

    let finalizeCallId: string | undefined;
    if (params.status === "completed") {
      finalizeCallId = call.id;
    } else {
      await callHooks.onStatus(ctx, call, params.status === "busy" ? "busy" : params.status === "no_answer" ? "no_answer" : "failed");
    }
    return { call: updated, finalizeCallId };
  },

  /** Applies a provider status and finalizes inline (used by tests and non-webhook callers). */
  async updateStatusFromProvider(params: ProviderStatusUpdate) {
    const { call, finalizeCallId } = await callsService.applyProviderStatus(params);
    if (finalizeCallId && call) {
      await callsService.finalizeCall(systemContext(call.organizationId, "exotel-webhook"), { callId: finalizeCallId });
    }
    return call;
  },

  /**
   * Safety net for calls whose terminal provider callback never arrived
   * (dropped webhook, crashed server, lost socket), across ALL organizations.
   * Never-answered calls are failed (modules are told); long-running answered
   * calls are completed and finalized from whatever transcript exists. Each
   * call is handled in its own organization's system context. Uses the same
   * atomic terminal transition as real callbacks, so it cannot double-close
   * or race a callback arriving at the same moment.
   */
  async reapStaleCalls(params: { pendingMs: number; inProgressMs: number; now?: Date }) {
    const now = params.now ?? new Date();
    const stale = await callsRepository.listStaleAnyOrg({
      pendingBefore: new Date(now.getTime() - params.pendingMs),
      inProgressBefore: new Date(now.getTime() - params.inProgressMs),
    });
    let closed = 0;
    for (const call of stale) {
      try {
        const ctx = systemContext(call.organizationId, "reaper");
        const answered = call.status === "in_progress";
        const updated = await callsRepository.transitionToTerminal({
          organizationId: call.organizationId,
          id: call.id,
          status: answered ? "completed" : "failed",
          endedAt: now,
        });
        if (!updated) continue; // a real callback got there first
        closed++;
        logger.warn("calls.service: closed stale call", { callId: call.id, previousStatus: call.status });
        if (answered) await this.finalizeCall(ctx, { callId: call.id });
        else await callHooks.onStatus(ctx, call, "failed");
      } catch (err) {
        logger.error("calls.service: failed to close stale call", {
          callId: call.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { closed };
  },

  /**
   * Runs the post-call pipeline: generate a structured summary from the persisted transcript (the agent's
   * template decides which kind), store it, and let modules react (the Sales module updates the lead).
   * Idempotent: if the conversation already has a summary, the stored result is returned and nothing is
   * regenerated or re-applied.
   */
  async finalizeCall(ctx: RequestContext, params: { callId: string }) {
    const org = ctx.organizationId;
    const call = await callsRepository.findById({ organizationId: org, id: params.callId });
    if (!call) throw new NotFoundError(`Call ${params.callId} not found`);

    const conversation = await conversationsRepository.findByCallId({ organizationId: org, callId: params.callId });
    if (conversation?.summary) {
      return (conversation.qualification as unknown) ?? null;
    }
    const transcript = (conversation?.transcript as TranscriptTurn[] | null) ?? [];

    const agent = call.agentId ? await agentsRepository.findById({ organizationId: org, id: call.agentId }) : null;
    // The agent's template decides the summary profile (a module's template names its own); an unknown agent gets the
    // legacy default, and anything unregistered or unspecified is generic.
    const profile: SummaryProfile = !agent
      ? legacyDefaultSummaryProfile()
      : getPromptTemplate(agent.promptTemplateKey)?.summaryProfile ?? "generic";

    const llm = getLlmProvider();
    const summary = await generateCallSummary(llm, transcript, profile);

    // Atomic claim: only the finalization that actually writes the summary goes on to update modules and usage.
    const stored = await conversationsRepository.setSummaryIfAbsent({
      organizationId: org,
      callId: params.callId,
      summary: String((summary as { summary?: unknown }).summary ?? ""),
      qualification: summary as unknown as Record<string, unknown>,
    });
    if (!stored) return summary;

    await callHooks.onFinalized(ctx, call, summary);

    // Only the finalization that stored the summary reaches here; the ledger is also dedupe-keyed.
    await usageService.recordCallUsage(ctx, params.callId);

    logger.info("calls.service: call finalized", { callId: params.callId, callType: call.callType, profile });

    return summary;
  },
};

const SIMULATED_NUMBER = "+910000000000";

/** The mock provider (runs the local call simulator), regardless of which provider the environment selects. */
function simulationProvider(): ITelephonyProvider {
  const configured = getTelephonyProvider();
  return configured.name === "mock" ? configured : new MockTelephonyProvider();
}
