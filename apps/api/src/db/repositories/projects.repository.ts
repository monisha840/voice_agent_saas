import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { projects, projectKnowledge } from "../schema.js";

/**
 * Repository for the `projects` and `project_knowledge` tables.
 *
 * No tenant_id filtering yet (single implicit demo tenant — see
 * MVP_IMPLEMENTATION_PLAN.md §2). Methods still take an options object
 * rather than positional args so a `tenantId` field can be added to each
 * signature later without changing every call site's argument order.
 */

export const projectsRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1);
    return rows[0] ?? null;
  },

  async list() {
    return db.select().from(projects);
  },

  async getKnowledge(params: { projectId: string }) {
    return db
      .select()
      .from(projectKnowledge)
      .where(eq(projectKnowledge.projectId, params.projectId));
  },
};
