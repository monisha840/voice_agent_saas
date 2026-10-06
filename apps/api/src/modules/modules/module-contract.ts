/**
 * What an optional module (Sales, and later others) can contribute to the Voice AI core.
 *
 * The dependency runs one way: a module imports these contracts and registers an implementation; the core only
 * ever talks to the registries those registrations fill (tools, call hooks, prompt templates, summary profiles).
 * The core never imports a module's code. With no module registered the core is a plain generic voice agent.
 */
import type { z } from "zod";
import type { RequestContext } from "../../auth/context.js";
import type { AiTool } from "../../ai-tools/types.js";
import type { ILanguageModel } from "../../adapters/ai/llm.interface.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";
import type { AgentRow } from "../../db/repositories/agents.repository.js";
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import type { PromptParams } from "../ai-agent/persona.js";
import type { CallHooks } from "../calls/call-hooks.js";
import type { FastifyInstance } from "fastify";
import type { ModulePermissionSet } from "../../auth/permissions.js";
import type { ScopeProvider } from "../../auth/access.js";

/** A system-prompt template an agent can select with its promptTemplateKey. */
export interface PromptTemplateDef {
  key: string;
  build(params: PromptParams, config?: Partial<ResolvedAgentConfig> | null): string;
  /** Used when a config carries no template key (the pre-agents behaviour). At most one registered template should claim it. */
  legacyDefault?: boolean;
  /** Key of the summary profile used to summarise calls of agents on this template. Absent = the generic profile. */
  summaryProfile?: string;
  /** The module that owns this template. Creating or switching an agent to it requires that module to be enabled for the organization. */
  moduleKey?: string;
  /** Tools an agent created on this template gets when the request names none (end_call is always added). */
  defaultTools?: readonly string[];
  /** Lets the template adjust the runtime config built for one agent (its own settings, its own tool wording). */
  configureRuntime?(input: { agent: AgentRow; effectiveTools: readonly string[]; config: ResolvedAgentConfig }): ResolvedAgentConfig;
}

/** A way of summarising a finished call. The result is stored as-is, so a profile owns its own shape. */
export interface SummaryProfileDef {
  key: string;
  /** Used when the call's agent is unknown or its template names no profile. At most one registered profile should claim it. */
  legacyDefault?: boolean;
  generate(llm: ILanguageModel, transcript: TranscriptTurn[]): Promise<unknown>;
}

/**
 * A module's own settings block inside an agent's `moduleConfig` (stored as moduleConfig[key]). The core stores
 * and merges it without knowing what the settings mean; the module defines the shape, defaults and normalisation.
 */
export interface AgentConfigSectionDef {
  /** The key under moduleConfig, normally the module's own key. */
  key: string;
  /** Validates a request's section. Must accept partial input and reject unknown fields. */
  schema: z.ZodType<Record<string, unknown>>;
  /** Values a section starts from when it is first written. */
  defaults: Readonly<Record<string, unknown>>;
  /** Reads a stored section defensively (stored JSON is never trusted); undefined when the agent has none. */
  normalize(raw: unknown): Record<string, unknown> | undefined;
}

/**
 * A kind of knowledge an agent can be bound to (a project for Sales; documents, FAQs or URLs for later modules).
 * The core stores the (sourceType, sourceId) binding and nothing else about it.
 */
export interface KnowledgeSourceDef {
  sourceType: string;
  /** Binding this source type requires its module to be enabled for the organization. */
  moduleKey: string;
  /** Optional once-per-request preparation (e.g. resolving the caller's scope); its result is passed to assertSource. */
  prepare?(ctx: RequestContext): Promise<unknown>;
  /** Throws (a ValidationError) unless the source exists and the caller may use it. Called once per binding. */
  assertSource(ctx: RequestContext, sourceId: string, prepared: unknown): Promise<void>;
}

/** An HTTP route plugin contributed by a module. */
export type ModuleRoutePlugin = (app: FastifyInstance) => Promise<void>;

export interface ModuleManifest {
  /** Matches the module's key in the module catalogue (organization_modules). */
  key: string;
  tools?: readonly AiTool<never, unknown>[];
  callHooks?: CallHooks;
  promptTemplates?: readonly PromptTemplateDef[];
  summaryProfiles?: readonly SummaryProfileDef[];
  agentConfigSections?: readonly AgentConfigSectionDef[];
  knowledgeSources?: readonly KnowledgeSourceDef[];
  /** Permissions the module adds to the permission matrix (they exist only while the module is registered). */
  permissions?: ModulePermissionSet;
  /** How the module narrows what a user may see (e.g. which leads and projects). */
  scopeProvider?: ScopeProvider;
  /**
   * HTTP routes. The core registers them inside a scope that refuses users of organizations that have not enabled
   * this module (modules/modules/module-routes.ts), so the routes themselves never need to check.
   */
  routes?: readonly ModuleRoutePlugin[];
}
