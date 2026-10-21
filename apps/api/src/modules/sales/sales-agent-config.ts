import { z } from "zod";
import type { AgentRow } from "../../db/repositories/agents.repository.js";
import type { AgentConfigSectionDef, KnowledgeSourceDef } from "../modules/module-contract.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { projectScopeFor } from "../../auth/access.js";
import { ValidationError } from "../../shared/errors.js";
import { DEFAULT_SALES_CONFIG, SALES_MODULE_KEY, SOURCE_TYPE_PROJECT } from "./sales-constants.js";

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

const salesConfigSchema = z
  .object({
    offerSlots: z.number().int().min(1).max(3),
    autoBook: z.boolean(),
  })
  .partial()
  .strict();

/** Sales settings from a raw stored moduleConfig.sales (only when the agent has any), normalised. */
function normalizeSalesConfig(raw: unknown): { offerSlots: number; autoBook: boolean } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  return {
    offerSlots: clampInt(s.offerSlots, 1, 3, DEFAULT_SALES_CONFIG.offerSlots),
    autoBook: typeof s.autoBook === "boolean" ? s.autoBook : DEFAULT_SALES_CONFIG.autoBook,
  };
}

/** The agent's stored Sales settings (slots offered, auto-booking), or undefined when it has none. */
export function agentSalesConfig(agent: Pick<AgentRow, "moduleConfig">) {
  const mc = (agent.moduleConfig ?? {}) as Record<string, unknown>;
  return normalizeSalesConfig(mc[SALES_MODULE_KEY]);
}

/** Sales' block inside an agent's moduleConfig. */
export const salesAgentConfigSection: AgentConfigSectionDef = {
  key: SALES_MODULE_KEY,
  schema: salesConfigSchema,
  defaults: DEFAULT_SALES_CONFIG,
  normalize: normalizeSalesConfig,
};

/** Projects as agent knowledge: the project must exist in the caller's organization and project scope. */
export const salesProjectKnowledgeSource: KnowledgeSourceDef = {
  sourceType: SOURCE_TYPE_PROJECT,
  moduleKey: SALES_MODULE_KEY,
  async prepare(ctx) {
    return projectScopeFor(ctx);
  },
  async assertSource(ctx, sourceId, prepared) {
    const scope = prepared as Awaited<ReturnType<typeof projectScopeFor>>;
    const project = await projectsRepository.findById({ organizationId: ctx.organizationId, id: sourceId, scope });
    if (!project) throw new ValidationError(`Project ${sourceId} was not found`);
  },
};
