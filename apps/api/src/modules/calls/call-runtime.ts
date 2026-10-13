/**
 * Builds everything the live conversation needs for one call, from the call itself:
 *
 *   call -> its agent (persona, prompt, language, behaviour, tools)
 *        -> the call's subject, as described by whichever modules are plugged in (lead, project, ...)
 *        -> the tools this agent may actually use right now (agent's tools ∩ enabled modules ∩ call context)
 *
 * The result is plain data for ConversationSession; this file is the only place that turns a stored agent
 * into a runtime configuration. It is lead-agnostic: a call with no lead simply has no lead in its subject.
 */
import type { RequestContext } from "../../auth/context.js";
import type { AgentRow } from "../../db/repositories/agents.repository.js";
import { resolveEffectiveTools } from "../../ai-tools/effective-tools.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";
import { agentsService, behaviourOf, enabledToolsOf } from "../agents/agents.service.js";
import type { PromptTemplateKey, ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import { getPromptTemplate, type PromptParams } from "../ai-agent/persona.js";
import { modulesService } from "../modules/modules.service.js";
import { callHooks, type HookCall } from "./call-hooks.js";

export interface CallRuntime {
  agent: AgentRow;
  config: ResolvedAgentConfig;
  promptParams: PromptParams;
  toolContext: ToolExecutionContext;
  /** Language hint for STT/TTS; undefined lets the provider auto-detect (the default English agent). */
  languageCode: string | undefined;
  /** The agent's configured TTS voice (a provider-specific speaker name); undefined = the provider's default voice. */
  voice: string | undefined;
  /** True when the agent answers in whatever language the caller is speaking (per turn); false = one fixed language. */
  replyInCallerLanguage: boolean;
  /** The tools exposed to the model for this call. */
  effectiveTools: string[];
}

const DEFAULT_LANGUAGE = "en-IN";

export const callRuntime = {
  async build(ctx: RequestContext, call: HookCall): Promise<CallRuntime> {
    if (!call.agentId) throw new Error(`Call ${call.id} has no agent`);
    const agent = await agentsService.getRuntimeAgent(ctx, { agentId: call.agentId });
    if (!agent) throw new Error(`Agent ${call.agentId} not found for call ${call.id}`);

    const subject = await callHooks.resolveSubject(ctx, call, agent);
    const enabledModules = await modulesService.enabledKeys({ organizationId: ctx.organizationId });
    const effectiveTools = resolveEffectiveTools({
      enabledTools: enabledToolsOf(agent),
      enabledModules,
      context: Object.fromEntries((subject.provides ?? []).map((r) => [r, true])),
    });

    // "generic" is built in; any other key must belong to a registered module's template, else the agent is generic.
    const template: PromptTemplateKey = (agent.promptTemplateKey === "generic" || !getPromptTemplate(agent.promptTemplateKey)
      ? "generic"
      : agent.promptTemplateKey) as PromptTemplateKey;
    const behaviour = behaviourOf(agent);
    const base: ResolvedAgentConfig = {
      agentName: agent.personaName,
      companyName: agent.companyName,
      greeting: agent.greeting,
      disclosureText: agent.disclosureText,
      language: agent.language,
      tone: agent.tone,
      callObjective: agent.callObjective,
      qualificationQuestions: behaviour.conversationQuestions,
      callBehaviour: { maxResponseSentences: behaviour.maxResponseSentences, endCallWhenDone: behaviour.endCallWhenDone },
      allowedTools: effectiveTools,
      // What the session really offers and executes: always an explicit list, never "empty means all".
      effectiveTools,
      siteVisitBehaviour: { offerSlots: 3, autoBook: true },
      extraInstructions: agent.extraInstructions,
      promptTemplateKey: template,
      systemPrompt: agent.systemPrompt,
      voice: agent.voice,
    };
    // The template's module may adjust the config (its own settings, its own prompt wording).
    const config = getPromptTemplate(template)?.configureRuntime?.({ agent, effectiveTools, config: base }) ?? base;

    return {
      agent,
      config,
      promptParams: {
        ...subject.promptParams,
        contactName: subject.contactName ?? call.counterpartyName ?? null,
        direction: call.callType === "inbound" ? "inbound" : "outbound",
        callType: call.callType,
      },
      toolContext: {
        organizationId: ctx.organizationId,
        callId: call.id,
        agentId: agent.id,
        callType: call.callType,
        ...(subject.context && Object.keys(subject.context).length > 0 ? { subject: subject.context } : {}),
      },
      // Legacy behaviour: an English agent (the default) leaves language detection to the speech provider.
      languageCode: agent.language === DEFAULT_LANGUAGE ? undefined : agent.language,
      voice: agent.voice?.trim() ? agent.voice.trim() : undefined,
      replyInCallerLanguage: behaviour.replyInCallerLanguage === true,
      effectiveTools,
    };
  },
};

