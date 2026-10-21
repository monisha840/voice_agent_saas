import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../client.js";
import { agentConfigs } from "../schema.js";

type AgentConfigValues = Omit<typeof agentConfigs.$inferInsert, "id" | "organizationId" | "projectId" | "createdAt" | "updatedAt">;

/**
 * Repository for `agent_configs`. projectId null = the organization default,
 * set = a per-project override. Every method requires organizationId.
 */
export const agentConfigsRepository = {
  async find(params: { organizationId: string; projectId: string | null }) {
    const rows = await db
      .select()
      .from(agentConfigs)
      .where(
        and(
          eq(agentConfigs.organizationId, params.organizationId),
          params.projectId ? eq(agentConfigs.projectId, params.projectId) : isNull(agentConfigs.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Atomic insert-or-update against the partial unique indexes (one default per org, one per project). */
  async upsert(params: { organizationId: string; projectId: string | null; values: AgentConfigValues }) {
    const insert = { ...params.values, organizationId: params.organizationId, projectId: params.projectId };
    const set = { ...params.values, updatedAt: new Date() };
    const query = db.insert(agentConfigs).values(insert);
    const rows = await (params.projectId
      ? query.onConflictDoUpdate({
          target: [agentConfigs.organizationId, agentConfigs.projectId],
          targetWhere: sql`${agentConfigs.projectId} is not null`,
          set,
        })
      : query.onConflictDoUpdate({
          target: [agentConfigs.organizationId],
          targetWhere: sql`${agentConfigs.projectId} is null`,
          set,
        })
    ).returning();
    return rows[0];
  },

  async remove(params: { organizationId: string; projectId: string | null }) {
    const rows = await db
      .delete(agentConfigs)
      .where(
        and(
          eq(agentConfigs.organizationId, params.organizationId),
          params.projectId ? eq(agentConfigs.projectId, params.projectId) : isNull(agentConfigs.projectId),
        ),
      )
      .returning({ id: agentConfigs.id });
    return rows.length;
  },
};
