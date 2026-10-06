import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { projects, projectKnowledge } from "../schema.js";
import type { ProjectScope } from "../../auth/scope.js";
import type { KnowledgeCategory } from "../../modules/projects/knowledge.schemas.js";

function scopeCondition(scope?: ProjectScope): SQL | undefined {
  if (!scope || scope.kind === "all") return undefined;
  return scope.projectIds.length > 0 ? inArray(projects.id, scope.projectIds) : sql`false`;
}

/**
 * Repository for `projects` and `project_knowledge`. Every method requires
 * an organizationId and filters by it, so one organization can never read
 * another's rows through this layer. Read methods take an optional `scope`
 * that narrows results to the projects a MANAGER/AGENT may see.
 */
export const projectsRepository = {
  async findById(params: { organizationId: string; id: string; scope?: ProjectScope }) {
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, params.organizationId), eq(projects.id, params.id), scopeCondition(params.scope)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Archived projects are excluded unless includeArchived is set. */
  async list(params: { organizationId: string; scope?: ProjectScope; includeArchived?: boolean }) {
    return db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, params.organizationId),
          params.includeArchived ? undefined : ne(projects.status, "archived"),
          scopeCondition(params.scope),
        ),
      )
      .orderBy(asc(projects.createdAt));
  },

  /** Exact-name lookup among the organization's non-archived projects (duplicate check). */
  async findActiveByName(params: { organizationId: string; name: string; excludeId?: string }) {
    const rows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, params.organizationId),
          eq(projects.name, params.name),
          ne(projects.status, "archived"),
          params.excludeId ? ne(projects.id, params.excludeId) : undefined,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async create(params: { organizationId: string; name: string; location: string; description?: string }) {
    const rows = await db
      .insert(projects)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        location: params.location,
        description: params.description ?? null,
      })
      .returning();
    return rows[0];
  },

  async update(params: {
    organizationId: string;
    id: string;
    patch: { name?: string; location?: string; description?: string | null };
  }) {
    const rows = await db
      .update(projects)
      .set({ ...params.patch, updatedAt: new Date() })
      .where(and(eq(projects.organizationId, params.organizationId), eq(projects.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  async setArchived(params: { organizationId: string; id: string; archived: boolean }) {
    const rows = await db
      .update(projects)
      .set({
        status: params.archived ? "archived" : "active",
        archivedAt: params.archived ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.organizationId, params.organizationId), eq(projects.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  /** One row per (project, category): inserts, or replaces the content of the existing row. */
  async upsertKnowledge(params: { organizationId: string; projectId: string; category: KnowledgeCategory; content: unknown }) {
    const rows = await db
      .insert(projectKnowledge)
      .values({
        organizationId: params.organizationId,
        projectId: params.projectId,
        category: params.category,
        content: params.content,
      })
      .onConflictDoUpdate({
        target: [projectKnowledge.projectId, projectKnowledge.category],
        set: { content: params.content, updatedAt: new Date() },
      })
      .returning();
    return rows[0];
  },

  async deleteKnowledge(params: { organizationId: string; projectId: string; category: KnowledgeCategory }) {
    const rows = await db
      .delete(projectKnowledge)
      .where(
        and(
          eq(projectKnowledge.organizationId, params.organizationId),
          eq(projectKnowledge.projectId, params.projectId),
          eq(projectKnowledge.category, params.category),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async getKnowledge(params: { organizationId: string; projectId: string }) {
    return db
      .select()
      .from(projectKnowledge)
      .where(
        and(
          eq(projectKnowledge.organizationId, params.organizationId),
          eq(projectKnowledge.projectId, params.projectId),
        ),
      );
  },
};
