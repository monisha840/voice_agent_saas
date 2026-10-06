import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentKnowledgeBindings } from "../../db/schema.js";
import { agentsRepository, type AgentValues, type Tx } from "../../db/repositories/agents.repository.js";
import { END_CALL_TOOL } from "../agents/agents.constants.js";
import { SALES_TOOL_NAMES, SOURCE_TYPE_PROJECT } from "../sales/sales-constants.js";
import { agentConfigsRepository } from "../../db/repositories/agent-configs.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { assertCan, can, projectScopeFor } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { NotFoundError } from "../../shared/errors.js";
import { parseInput } from "../../shared/validation.js";
import { isKnownToolName } from "../../ai-tools/index.js";
import { auditService } from "../audit/audit.service.js";
import { AGENT_NAME, COMPANY_NAME } from "../ai-agent/persona.js";
import { SUPPORTED_LANGUAGES, TONES, upsertAgentConfigSchema, type AgentConfigFields } from "./agent-config.validation.js";
import type { AgentConfigSource, ResolvedAgentConfig } from "./agent-config.types.js";

/**
 * LEGACY FAÇADE. The `agent_configs` table is no longer read by calls: the live call path (calls/call-runtime.ts)
 * reads only `agents`. This service keeps its behaviour and storage unchanged, and additionally WRITES THROUGH
 * every successful upsert/reset to `agents` (the org default agent, or the agent bound to the project), using the
 * same field mapping as migration 0007's backfill, so edits made through the old /api/agent-config API still
 * affect real calls. The sync is derived from the stored legacy row and is idempotent: if it fails the request
 * fails (500) and repeating the same request heals it. This façade will be removed together with the legacy
 * table in a later, separately-approved migration.
 */

/** Exactly today's behavior: the built-in persona, every tool, English. */
export const DEFAULT_AGENT_CONFIG: Readonly<ResolvedAgentConfig> = Object.freeze({
  agentName: AGENT_NAME,
  companyName: COMPANY_NAME,
  greeting: null,
  disclosureText: null,
  language: "en-IN",
  tone: "professional",
  callObjective: null,
  qualificationQuestions: [],
  callBehaviour: { maxResponseSentences: 3, endCallWhenDone: true },
  allowedTools: [],
  siteVisitBehaviour: { offerSlots: 3, autoBook: true },
  extraInstructions: null,
});

type Row = NonNullable<Awaited<ReturnType<typeof agentConfigsRepository.find>>>;

const optText = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

/** Builds the effective config from a stored row; a corrupt column falls back to the default for that field. */
function fromRow(row: Row): ResolvedAgentConfig {
  const d = DEFAULT_AGENT_CONFIG;
  const cb = (row.callBehaviour ?? {}) as Record<string, unknown>;
  const sv = (row.siteVisitBehaviour ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(row.qualificationQuestions) ? row.qualificationQuestions : [];
  const tools = Array.isArray(row.allowedTools) ? row.allowedTools : [];
  return {
    agentName: row.agentName?.trim() || d.agentName,
    companyName: row.companyName?.trim() || d.companyName,
    greeting: optText(row.greeting),
    disclosureText: optText(row.disclosureText),
    language: (SUPPORTED_LANGUAGES as readonly string[]).includes(row.language) ? row.language : d.language,
    tone: (TONES as readonly string[]).includes(row.tone) ? row.tone : d.tone,
    callObjective: optText(row.callObjective),
    qualificationQuestions: questions.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 3),
    callBehaviour: {
      maxResponseSentences: clampInt(cb.maxResponseSentences, 1, 6, d.callBehaviour.maxResponseSentences),
      endCallWhenDone: typeof cb.endCallWhenDone === "boolean" ? cb.endCallWhenDone : d.callBehaviour.endCallWhenDone,
    },
    allowedTools: tools.filter((t): t is string => typeof t === "string" && isKnownToolName(t)),
    siteVisitBehaviour: {
      offerSlots: clampInt(sv.offerSlots, 1, 3, d.siteVisitBehaviour.offerSlots),
      autoBook: typeof sv.autoBook === "boolean" ? sv.autoBook : d.siteVisitBehaviour.autoBook,
    },
    extraInstructions: optText(row.extraInstructions),
  };
}

async function effective(organizationId: string, projectId: string | null) {
  if (projectId) {
    const row = await agentConfigsRepository.find({ organizationId, projectId });
    if (row) return { config: fromRow(row), source: "project" as AgentConfigSource };
  }
  const row = await agentConfigsRepository.find({ organizationId, projectId: null });
  if (row) return { config: fromRow(row), source: "organization" as AgentConfigSource };
  return { config: { ...DEFAULT_AGENT_CONFIG }, source: "default" as AgentConfigSource };
}

/** The project must exist in the caller's organization AND be within their project scope; otherwise 404. */
async function assertProjectVisible(ctx: RequestContext, projectId: string) {
  const scope = await projectScopeFor(ctx);
  const project = await projectsRepository.findById({ organizationId: ctx.organizationId, id: projectId, scope });
  if (!project) throw new NotFoundError("Project not found");
  return project;
}

// ---------------------------------------------------------------------------------------------------------------
// Write-through to `agents` (see the façade note above).
// ---------------------------------------------------------------------------------------------------------------

type MirroredValues = Pick<
  AgentValues,
  | "personaName" | "companyName" | "greeting" | "disclosureText" | "language" | "tone" | "callObjective"
  | "extraInstructions" | "behaviour" | "enabledTools"
> & { sales: { offerSlots: number; autoBook: boolean } };

/** Legacy row -> agent fields, exactly like the 0007 backfill (empty tool list = every tool; otherwise list + end_call). */
function mirrorFromRow(row: Row): MirroredValues {
  const c = fromRow(row);
  return {
    personaName: c.agentName,
    companyName: row.companyName?.trim() || null,
    greeting: c.greeting,
    disclosureText: c.disclosureText,
    language: c.language,
    tone: c.tone,
    callObjective: c.callObjective,
    extraInstructions: c.extraInstructions,
    behaviour: { ...c.callBehaviour, conversationQuestions: c.qualificationQuestions },
    enabledTools:
      c.allowedTools.length === 0
        ? [...SALES_TOOL_NAMES]
        : c.allowedTools.includes(END_CALL_TOOL)
          ? c.allowedTools
          : [...c.allowedTools, END_CALL_TOOL],
    sales: { ...c.siteVisitBehaviour },
  };
}

/** The built-in defaults, as agent fields (used when the org default is reset). */
function builtInMirror(): MirroredValues {
  const d = DEFAULT_AGENT_CONFIG;
  return {
    personaName: d.agentName,
    companyName: null,
    greeting: null,
    disclosureText: null,
    language: d.language,
    tone: d.tone,
    callObjective: null,
    extraInstructions: null,
    behaviour: { ...d.callBehaviour, conversationQuestions: [] },
    enabledTools: [...SALES_TOOL_NAMES],
    sales: { ...d.siteVisitBehaviour },
  };
}

function agentPatch(m: MirroredValues, existingModuleConfig: unknown, userId: string | null): Partial<AgentValues> {
  const { sales, ...rest } = m;
  const mc = existingModuleConfig && typeof existingModuleConfig === "object" ? (existingModuleConfig as Record<string, unknown>) : {};
  return { ...rest, moduleConfig: { ...mc, sales }, updatedByUserId: userId };
}

async function uniqueAgentName(tx: Tx, organizationId: string, base: string): Promise<string> {
  const taken = new Set((await agentsRepository.list({ organizationId }, tx)).map((a) => a.name.toLowerCase()));
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
  return candidate;
}

async function createAgentFor(
  tx: Tx,
  organizationId: string,
  name: string,
  m: MirroredValues,
  userId: string | null,
  isDefault: boolean,
) {
  const { sales, ...rest } = m;
  return agentsRepository.create(
    {
      organizationId,
      values: {
        ...rest,
        name: await uniqueAgentName(tx, organizationId, name),
        status: "active",
        isDefault,
        promptTemplateKey: "sales_real_estate",
        moduleConfig: { sales },
        createdByUserId: userId,
        updatedByUserId: userId,
      },
    },
    tx,
  );
}

/** Mirrors an org-default legacy config (or the built-ins) onto the org default agent; creates one if none exists. */
async function syncDefaultAgent(organizationId: string, m: MirroredValues, userId: string | null) {
  await db.transaction(async (tx) => {
    const agent = await agentsRepository.findDefault({ organizationId }, tx);
    if (agent) await agentsRepository.update({ organizationId, id: agent.id, values: agentPatch(m, agent.moduleConfig, userId) }, tx);
    else await createAgentFor(tx, organizationId, "Default agent", m, userId, true);
  });
}

/**
 * Mirrors a project override onto the ACTIVE agent bound to the project, or creates "<project> agent" + a project binding.
 * Decision: if the project's bound agent is the org DEFAULT, it is never converted into an override (that would
 * silently change every other call). A separate override agent is created instead, and the project binding is moved
 * off the default agent to it: findBoundToProject picks the oldest bound agent (the default), so leaving both bound
 * would make the legacy override a no-op, whereas the old semantics are "project override > organization default".
 */
async function syncProjectAgent(organizationId: string, projectId: string, projectName: string, m: MirroredValues, userId: string | null) {
  await db.transaction(async (tx) => {
    const bound = await agentsRepository.findBoundToProject({ organizationId, projectId }, tx);
    if (bound && !bound.isDefault) {
      await agentsRepository.update({ organizationId, id: bound.id, values: agentPatch(m, bound.moduleConfig, userId) }, tx);
      return;
    }
    if (bound) {
      await tx
        .delete(agentKnowledgeBindings)
        .where(
          and(
            eq(agentKnowledgeBindings.organizationId, organizationId),
            eq(agentKnowledgeBindings.agentId, bound.id),
            eq(agentKnowledgeBindings.sourceType, SOURCE_TYPE_PROJECT),
            eq(agentKnowledgeBindings.sourceId, projectId),
          ),
        );
    }
    const agent = await createAgentFor(tx, organizationId, `${projectName.slice(0, 100)} agent`, m, userId, false);
    await tx
      .insert(agentKnowledgeBindings)
      .values({ organizationId, agentId: agent.id, sourceType: SOURCE_TYPE_PROJECT, sourceId: projectId })
      .onConflictDoNothing();
  });
}

/** Archives (never deletes: calls reference agents) the project's bound agent; the org default is never archived. */
async function archiveProjectAgent(organizationId: string, projectId: string, userId: string | null) {
  await db.transaction(async (tx) => {
    const bound = await agentsRepository.findBoundToProject({ organizationId, projectId }, tx);
    if (bound && !bound.isDefault) {
      await agentsRepository.update({ organizationId, id: bound.id, values: { status: "archived", updatedByUserId: userId } }, tx);
    }
  });
}

/** A failed sync must not look like success: the legacy write is already stored, repeating the request heals it. */
async function mirrorOrFail(op: () => Promise<void>) {
  try {
    await op();
  } catch (err) {
    throw new Error(
      `Agent configuration was saved but could not be applied to the agent used by calls; repeat the request to retry (${(err as Error).message})`,
      { cause: err },
    );
  }
}

export const agentConfigService = {
  /**
   * The EFFECTIVE config for a project: project override > organization default > built-in default.
   * Used by the live call path (system context); never fails because of a missing config.
   */
  async resolve(ctx: RequestContext, params: { projectId?: string | null }) {
    return effective(ctx.organizationId, params.projectId ?? null);
  },

  async getForManagement(ctx: RequestContext, params: { projectId?: string }) {
    assertCan(ctx, "agent-config:read");
    if (params.projectId) await assertProjectVisible(ctx, params.projectId);
    const { config, source } = await effective(ctx.organizationId, params.projectId ?? null);
    return { config, source, editable: can(ctx, "agent-config:manage") };
  },

  /** Partial update: fields present in the input are set, the rest keep their stored (or default) value. */
  async upsert(ctx: RequestContext, input: unknown) {
    assertCan(ctx, "agent-config:manage");
    const { projectId, ...fields } = parseInput(upsertAgentConfigSchema, input);
    const project = projectId ? await assertProjectVisible(ctx, projectId) : null;

    const existing = await agentConfigsRepository.find({ organizationId: ctx.organizationId, projectId: projectId ?? null });
    const before = existing ? fromRow(existing) : { ...DEFAULT_AGENT_CONFIG };
    const merged = { ...before, ...definedOnly(fields) } as ResolvedAgentConfig;
    // Fields stored as null mean "use the built-in value"; keep the DB nullable for them.
    const saved = await agentConfigsRepository.upsert({
      organizationId: ctx.organizationId,
      projectId: projectId ?? null,
      values: {
        agentName: merged.agentName,
        companyName: fields.companyName === undefined ? existing?.companyName ?? null : fields.companyName,
        greeting: merged.greeting,
        disclosureText: merged.disclosureText,
        language: merged.language,
        tone: merged.tone,
        callObjective: merged.callObjective,
        qualificationQuestions: merged.qualificationQuestions,
        callBehaviour: merged.callBehaviour,
        allowedTools: merged.allowedTools,
        siteVisitBehaviour: merged.siteVisitBehaviour,
        extraInstructions: merged.extraInstructions,
        updatedByUserId: ctx.actor.type === "user" ? ctx.actor.userId : null,
      },
    });

    const userId = ctx.actor.type === "user" ? ctx.actor.userId : null;
    await mirrorOrFail(() =>
      projectId && project
        ? syncProjectAgent(ctx.organizationId, projectId, project.name, mirrorFromRow(saved), userId)
        : syncDefaultAgent(ctx.organizationId, mirrorFromRow(saved), userId),
    );

    const after = fromRow(saved);
    const changed = (Object.keys(after) as Array<keyof ResolvedAgentConfig>).filter(
      (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]),
    );
    // Field NAMES only: prompt text never goes to the audit log.
    await auditService.record(ctx, {
      action: "agent_config.updated",
      entityType: "agent_config",
      entityId: saved.id,
      metadata: { projectId: projectId ?? null, changed },
    });
    return agentConfigService.getForManagement(ctx, { projectId });
  },

  /** Removes a project override (falls back to the org default) or resets the org default (falls back to the built-in). */
  async reset(ctx: RequestContext, params: { projectId?: string }) {
    assertCan(ctx, "agent-config:manage");
    if (params.projectId) await assertProjectVisible(ctx, params.projectId);
    const existing = await agentConfigsRepository.find({ organizationId: ctx.organizationId, projectId: params.projectId ?? null });
    if (!existing) throw new NotFoundError("No configuration to reset");
    await agentConfigsRepository.remove({ organizationId: ctx.organizationId, projectId: params.projectId ?? null });
    const userId = ctx.actor.type === "user" ? ctx.actor.userId : null;
    await mirrorOrFail(() =>
      params.projectId
        ? archiveProjectAgent(ctx.organizationId, params.projectId, userId)
        : syncDefaultAgent(ctx.organizationId, builtInMirror(), userId),
    );
    await auditService.record(ctx, {
      action: "agent_config.reset",
      entityType: "agent_config",
      entityId: existing.id,
      metadata: { projectId: params.projectId ?? null },
    });
    return agentConfigService.getForManagement(ctx, params);
  },
};

function definedOnly(fields: AgentConfigFields): Partial<ResolvedAgentConfig> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<ResolvedAgentConfig>;
}
