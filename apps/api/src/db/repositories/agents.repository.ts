import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client.js";
import { agentKnowledgeBindings, agents } from "../schema.js";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type AgentRow = typeof agents.$inferSelect;
export type AgentValues = Omit<typeof agents.$inferInsert, "id" | "organizationId" | "createdAt" | "updatedAt">;
export type AgentBindingRow = typeof agentKnowledgeBindings.$inferSelect;

/**
 * Repository for `agents` and `agent_knowledge_bindings`. Every method requires
 * organizationId and filters by it, so one organization can never read or change
 * another organization's agents through this layer.
 */
export const agentsRepository = {
  async findById(params: { organizationId: string; id: string }, tx: Executor = db): Promise<AgentRow | null> {
    const rows = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, params.organizationId), eq(agents.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** The organization's active default agent, if any. */
  async findDefault(params: { organizationId: string }, tx: Executor = db): Promise<AgentRow | null> {
    const rows = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, params.organizationId), eq(agents.isDefault, true), eq(agents.status, "active")))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * The active agent bound to a project, if any. Deterministic when several agents are bound:
   * the oldest agent (created_at, then id) wins.
   */
  async findBoundToProject(params: { organizationId: string; projectId: string }, tx: Executor = db): Promise<AgentRow | null> {
    const rows = await tx
      .select({ agent: agents })
      .from(agentKnowledgeBindings)
      .innerJoin(
        agents,
        and(eq(agents.organizationId, agentKnowledgeBindings.organizationId), eq(agents.id, agentKnowledgeBindings.agentId)),
      )
      .where(
        and(
          eq(agentKnowledgeBindings.organizationId, params.organizationId),
          eq(agentKnowledgeBindings.sourceType, "project"),
          eq(agentKnowledgeBindings.sourceId, params.projectId),
          eq(agents.status, "active"),
        ),
      )
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .limit(1);
    return rows[0]?.agent ?? null;
  },

  /** Default agent first, then oldest first. Archived agents only when asked. */
  async list(params: { organizationId: string; includeArchived?: boolean }, tx: Executor = db): Promise<AgentRow[]> {
    return tx
      .select()
      .from(agents)
      .where(
        and(eq(agents.organizationId, params.organizationId), params.includeArchived ? undefined : eq(agents.status, "active")),
      )
      .orderBy(desc(agents.isDefault), asc(agents.createdAt), asc(agents.id));
  },

  async create(params: { organizationId: string; values: AgentValues }, tx: Executor = db): Promise<AgentRow> {
    const rows = await tx
      .insert(agents)
      .values({ ...params.values, organizationId: params.organizationId })
      .returning();
    return rows[0];
  },

  async update(
    params: { organizationId: string; id: string; values: Partial<AgentValues> },
    tx: Executor = db,
  ): Promise<AgentRow | null> {
    const rows = await tx
      .update(agents)
      .set({ ...params.values, updatedAt: new Date() })
      .where(and(eq(agents.organizationId, params.organizationId), eq(agents.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Makes `id` the organization's only active default. Must run inside the caller's
   * transaction so the old default is cleared and the new one set atomically.
   */
  async setDefault(
    params: { organizationId: string; id: string; updatedByUserId?: string | null },
    tx: Tx,
  ): Promise<AgentRow | null> {
    await tx
      .update(agents)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(agents.organizationId, params.organizationId), eq(agents.isDefault, true), sql`${agents.id} <> ${params.id}`));
    const rows = await tx
      .update(agents)
      .set({ isDefault: true, updatedAt: new Date(), updatedByUserId: params.updatedByUserId ?? null })
      .where(and(eq(agents.organizationId, params.organizationId), eq(agents.id, params.id), eq(agents.status, "active")))
      .returning();
    return rows[0] ?? null;
  },

  async listBindings(params: { organizationId: string; agentIds: string[] }, tx: Executor = db): Promise<AgentBindingRow[]> {
    if (params.agentIds.length === 0) return [];
    return tx
      .select()
      .from(agentKnowledgeBindings)
      .where(
        and(
          eq(agentKnowledgeBindings.organizationId, params.organizationId),
          inArray(agentKnowledgeBindings.agentId, params.agentIds),
        ),
      )
      .orderBy(asc(agentKnowledgeBindings.createdAt), asc(agentKnowledgeBindings.sourceId));
  },

  /** Replace-all, atomically. Duplicate (type, id) pairs collapse to one. */
  async replaceBindings(params: {
    organizationId: string;
    agentId: string;
    bindings: Array<{ sourceType: string; sourceId: string }>;
  }): Promise<AgentBindingRow[]> {
    const unique = [...new Map(params.bindings.map((b) => [`${b.sourceType}:${b.sourceId}`, b])).values()];
    return db.transaction(async (tx) => {
      await tx
        .delete(agentKnowledgeBindings)
        .where(
          and(eq(agentKnowledgeBindings.organizationId, params.organizationId), eq(agentKnowledgeBindings.agentId, params.agentId)),
        );
      if (unique.length === 0) return [];
      return tx
        .insert(agentKnowledgeBindings)
        .values(unique.map((b) => ({ organizationId: params.organizationId, agentId: params.agentId, ...b })))
        .returning();
    });
  },
};
