import { db } from "../../db/client.js";
import { agentsRepository, type AgentRow, type AgentValues } from "../../db/repositories/agents.repository.js";
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { parseInput } from "../../shared/validation.js";
import { isKnownToolName } from "../../ai-tools/index.js";
import { SUPPORTED_LANGUAGES, TONES } from "../agent-config/agent-config.validation.js";
import { auditService } from "../audit/audit.service.js";
import { modulesService } from "../modules/modules.service.js";
import type { ModuleKey } from "../modules/module-registry.js";
import { getPromptTemplate } from "../ai-agent/persona.js";
import { getKnowledgeSource, mergeModuleConfig, normalizeModuleConfig } from "./agent-extensions.js";
import {
  DEFAULT_BEHAVIOUR,
  END_CALL_TOOL,
  defaultToolsFor,
  type PromptTemplateKey,
} from "./agents.constants.js";
import {
  createAgentSchema,
  listAgentsQuerySchema,
  replaceKnowledgeSchema,
  updateAgentSchema,
  type UpdateAgentInput,
} from "./agents.validation.js";

export interface AgentJson {
  id: string;
  name: string;
  personaName: string;
  companyName: string | null;
  description: string | null;
  status: string;
  isDefault: boolean;
  promptTemplateKey: string;
  systemPrompt: string | null;
  extraInstructions: string | null;
  callObjective: string | null;
  greeting: string | null;
  disclosureText: string | null;
  language: string;
  voice: string | null;
  tone: string;
  behaviour: { maxResponseSentences: number; endCallWhenDone: boolean; conversationQuestions: string[]; replyInCallerLanguage?: boolean };
  enabledTools: string[];
  /** Settings blocks of the modules plugged in, keyed by module (the core does not know their shape). */
  moduleConfig: Record<string, Record<string, unknown>>;
  knowledge: Array<{ sourceType: string; sourceId: string }>;
  createdAt: Date;
  updatedAt: Date;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

/** Normalised behaviour from a stored row; a corrupt field falls back to its default. */
export function behaviourOf(row: Pick<AgentRow, "behaviour">) {
  const b = (row.behaviour ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(b.conversationQuestions) ? b.conversationQuestions : [];
  return {
    maxResponseSentences: clampInt(b.maxResponseSentences, 1, 6, DEFAULT_BEHAVIOUR.maxResponseSentences),
    endCallWhenDone: typeof b.endCallWhenDone === "boolean" ? b.endCallWhenDone : DEFAULT_BEHAVIOUR.endCallWhenDone,
    conversationQuestions: questions.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 3),
    // Present only when switched on, so an agent that never set it reads exactly as before.
    ...(b.replyInCallerLanguage === true ? { replyInCallerLanguage: true } : {}),
  };
}

/** Enabled tools from a stored row: known names only, and "end_call" is always present. */
export function enabledToolsOf(row: Pick<AgentRow, "enabledTools">): string[] {
  const tools = Array.isArray(row.enabledTools) ? row.enabledTools : [];
  const known = tools.filter((t): t is string => typeof t === "string" && isKnownToolName(t));
  return known.includes(END_CALL_TOOL) ? known : [...known, END_CALL_TOOL];
}

export function toAgentJson(row: AgentRow, knowledge: Array<{ sourceType: string; sourceId: string }>): AgentJson {
  return {
    id: row.id,
    name: row.name,
    personaName: row.personaName,
    companyName: row.companyName,
    description: row.description,
    status: row.status,
    isDefault: row.isDefault,
    promptTemplateKey: row.promptTemplateKey,
    systemPrompt: row.systemPrompt,
    extraInstructions: row.extraInstructions,
    callObjective: row.callObjective,
    greeting: row.greeting,
    disclosureText: row.disclosureText,
    language: (SUPPORTED_LANGUAGES as readonly string[]).includes(row.language) ? row.language : "en-IN",
    voice: row.voice,
    tone: (TONES as readonly string[]).includes(row.tone) ? row.tone : "professional",
    behaviour: behaviourOf(row),
    enabledTools: enabledToolsOf(row),
    moduleConfig: normalizeModuleConfig(row.moduleConfig),
    knowledge,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A template owned by a module can only be used while that module is enabled for the organization. */
async function assertTemplateModuleEnabled(ctx: RequestContext, templateKey: string): Promise<void> {
  const moduleKey = getPromptTemplate(templateKey)?.moduleKey;
  if (moduleKey) await modulesService.assertEnabled(ctx, moduleKey as ModuleKey);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const userIdOf = (ctx: RequestContext) => (ctx.actor.type === "user" ? ctx.actor.userId : null);

async function loadOrThrow(ctx: RequestContext, id: string): Promise<AgentRow> {
  const row = await agentsRepository.findById({ organizationId: ctx.organizationId, id });
  if (!row) throw new NotFoundError("Agent not found");
  return row;
}

async function withKnowledge(ctx: RequestContext, rows: AgentRow[]): Promise<AgentJson[]> {
  const bindings = await agentsRepository.listBindings({ organizationId: ctx.organizationId, agentIds: rows.map((r) => r.id) });
  return rows.map((row) =>
    toAgentJson(
      row,
      bindings.filter((b) => b.agentId === row.id).map((b) => ({ sourceType: b.sourceType, sourceId: b.sourceId })),
    ),
  );
}

async function present(ctx: RequestContext, row: AgentRow): Promise<AgentJson> {
  return (await withKnowledge(ctx, [row]))[0];
}

function withEndCall(tools: string[]): string[] {
  const unique = [...new Set(tools)];
  return unique.includes(END_CALL_TOOL) ? unique : [...unique, END_CALL_TOOL];
}

/** What a role without `agents:read` may learn about an agent: just enough to select and display it. */
export interface AgentOption {
  id: string;
  name: string;
  personaName: string;
  status: string;
}

export const agentsService = {
  async list(ctx: RequestContext, query: unknown) {
    assertCan(ctx, "agents:read");
    const { includeArchived } = parseInput(listAgentsQuerySchema, query);
    const rows = await agentsRepository.list({ organizationId: ctx.organizationId, includeArchived });
    return withKnowledge(ctx, rows);
  },

  /**
   * The minimal read-only list for PICKING an agent (Test page, call filters): any role that may place calls
   * (`calls:create`) can see which active agents of its organization exist, and nothing more. Deliberately only
   * id, name, persona name and status: no prompt, tools, knowledge, language or other configuration.
   * Default agent first (the ordering is the only hint of which one is the default).
   */
  async listOptions(ctx: RequestContext): Promise<AgentOption[]> {
    assertCan(ctx, "calls:create");
    const rows = await agentsRepository.list({ organizationId: ctx.organizationId, includeArchived: false });
    return rows.map((r) => ({ id: r.id, name: r.name, personaName: r.personaName, status: r.status }));
  },

  async get(ctx: RequestContext, id: string) {
    assertCan(ctx, "agents:read");
    return present(ctx, await loadOrThrow(ctx, id));
  },

  /**
   * For the live call path (step 5): the agent row for an id, scoped to the organization, or null.
   * No permission check, so system contexts (media-stream, simulator) and users can both use it.
   * Archived agents are returned too: a call that already started keeps its agent.
   */
  async getRuntimeAgent(ctx: RequestContext, params: { agentId: string }): Promise<AgentRow | null> {
    return agentsRepository.findById({ organizationId: ctx.organizationId, id: params.agentId });
  },

  async create(ctx: RequestContext, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(createAgentSchema, input);
    const template: PromptTemplateKey = data.promptTemplateKey ?? "generic";
    await assertTemplateModuleEnabled(ctx, template);

    const userId = userIdOf(ctx);
    let row: AgentRow;
    try {
      // The first active agent of an organization becomes its default.
      const hasDefault = await agentsRepository.findDefault({ organizationId: ctx.organizationId });
      row = await agentsRepository.create({
        organizationId: ctx.organizationId,
        values: {
          name: data.name,
          personaName: data.personaName,
          companyName: data.companyName ?? null,
          description: data.description ?? null,
          status: "active",
          isDefault: !hasDefault,
          promptTemplateKey: template,
          systemPrompt: data.systemPrompt ?? null,
          extraInstructions: data.extraInstructions ?? null,
          callObjective: data.callObjective ?? null,
          greeting: data.greeting ?? null,
          disclosureText: data.disclosureText ?? null,
          language: data.language ?? "en-IN",
          voice: data.voice ?? null,
          tone: data.tone ?? "professional",
          behaviour: { ...DEFAULT_BEHAVIOUR, ...data.behaviour },
          enabledTools: withEndCall(data.enabledTools ?? defaultToolsFor(template)),
          moduleConfig: mergeModuleConfig({}, data.moduleConfig),
          createdByUserId: userId,
          updatedByUserId: userId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("An active agent with this name already exists");
      throw err;
    }
    await auditService.record(ctx, {
      action: "agent.created",
      entityType: "agent",
      entityId: row.id,
      metadata: { name: row.name, promptTemplateKey: row.promptTemplateKey, isDefault: row.isDefault },
    });
    return present(ctx, row);
  },

  /** Partial update: only the keys present change. Nested behaviour / moduleConfig sections are merged. */
  async update(ctx: RequestContext, id: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const patch: UpdateAgentInput = parseInput(updateAgentSchema, input);
    const before = await loadOrThrow(ctx, id);
    if (patch.promptTemplateKey && patch.promptTemplateKey !== before.promptTemplateKey) {
      await assertTemplateModuleEnabled(ctx, patch.promptTemplateKey);
    }

    const values: Partial<AgentValues> = {};
    const { behaviour, enabledTools, moduleConfig, ...plain } = patch;
    for (const [k, v] of Object.entries(plain)) {
      if (v !== undefined) (values as Record<string, unknown>)[k] = v;
    }
    if (behaviour) values.behaviour = { ...behaviourOf(before), ...behaviour };
    if (enabledTools) values.enabledTools = withEndCall(enabledTools);
    if (moduleConfig && Object.keys(moduleConfig).length > 0) {
      values.moduleConfig = mergeModuleConfig(before.moduleConfig, moduleConfig);
    }
    values.updatedByUserId = userIdOf(ctx);

    let after: AgentRow | null;
    try {
      after = await agentsRepository.update({ organizationId: ctx.organizationId, id, values });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("An active agent with this name already exists");
      throw err;
    }
    if (!after) throw new NotFoundError("Agent not found");

    const beforeJson = toAgentJson(before, []);
    const afterJson = toAgentJson(after, []);
    const changed = (Object.keys(patch) as Array<keyof AgentJson>).filter(
      (k) => JSON.stringify(afterJson[k]) !== JSON.stringify(beforeJson[k]),
    );
    // Field NAMES only: prompt text never goes to the audit log.
    await auditService.record(ctx, { action: "agent.updated", entityType: "agent", entityId: id, metadata: { changed } });
    return present(ctx, after);
  },

  async archive(ctx: RequestContext, id: string) {
    assertCan(ctx, "agents:manage");
    const agent = await loadOrThrow(ctx, id);
    if (agent.isDefault && agent.status === "active") {
      throw new ConflictError("The default agent cannot be archived. Make another agent the default first.");
    }
    if (agent.status === "archived") return present(ctx, agent);
    const after = await agentsRepository.update({
      organizationId: ctx.organizationId,
      id,
      values: { status: "archived", isDefault: false, updatedByUserId: userIdOf(ctx) },
    });
    await auditService.record(ctx, { action: "agent.archived", entityType: "agent", entityId: id, metadata: { name: agent.name } });
    return present(ctx, after!);
  },

  async unarchive(ctx: RequestContext, id: string) {
    assertCan(ctx, "agents:manage");
    const agent = await loadOrThrow(ctx, id);
    if (agent.status === "active") return present(ctx, agent);
    let after: AgentRow | null;
    try {
      after = await agentsRepository.update({
        organizationId: ctx.organizationId,
        id,
        values: { status: "active", updatedByUserId: userIdOf(ctx) },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("An active agent with this name already exists. Rename one of them first.");
      throw err;
    }
    await auditService.record(ctx, { action: "agent.unarchived", entityType: "agent", entityId: id, metadata: { name: agent.name } });
    return present(ctx, after!);
  },

  /** Atomic swap: the old default is cleared and the new one set in one transaction. */
  async setDefault(ctx: RequestContext, id: string) {
    assertCan(ctx, "agents:manage");
    const agent = await loadOrThrow(ctx, id);
    if (agent.status !== "active") throw new ConflictError("An archived agent cannot be the default. Unarchive it first.");
    if (agent.isDefault) return present(ctx, agent);
    const previous = await agentsRepository.findDefault({ organizationId: ctx.organizationId });
    const after = await db.transaction((tx) =>
      agentsRepository.setDefault({ organizationId: ctx.organizationId, id, updatedByUserId: userIdOf(ctx) }, tx),
    );
    if (!after) throw new NotFoundError("Agent not found");
    await auditService.record(ctx, {
      action: "agent.default_changed",
      entityType: "agent",
      entityId: id,
      metadata: { previousDefaultId: previous?.id ?? null },
    });
    return present(ctx, after);
  },

  /**
   * Replace-all knowledge bindings. Each source type belongs to a module: binding one requires that module to be
   * enabled and the source to pass the module's own check (e.g. a Sales project must exist in the caller's
   * organization and project scope). An empty list is always allowed.
   */
  async replaceKnowledge(ctx: RequestContext, id: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const { bindings } = parseInput(replaceKnowledgeSchema, input);
    const agent = await loadOrThrow(ctx, id);
    const prepared = new Map<string, unknown>();
    for (const b of bindings) {
      const source = getKnowledgeSource(b.sourceType);
      if (!source) throw new ValidationError(`Unsupported knowledge source type "${b.sourceType}"`);
      if (!prepared.has(b.sourceType)) {
        await modulesService.assertEnabled(ctx, source.moduleKey as ModuleKey);
        prepared.set(b.sourceType, await source.prepare?.(ctx));
      }
      await source.assertSource(ctx, b.sourceId, prepared.get(b.sourceType));
    }
    const rows = await agentsRepository.replaceBindings({ organizationId: ctx.organizationId, agentId: id, bindings });
    await auditService.record(ctx, {
      action: "agent.knowledge_updated",
      entityType: "agent",
      entityId: id,
      metadata: { name: agent.name, count: rows.length, sourceIds: rows.map((r) => r.sourceId) },
    });
    return present(ctx, (await agentsRepository.findById({ organizationId: ctx.organizationId, id })) ?? agent);
  },
};
