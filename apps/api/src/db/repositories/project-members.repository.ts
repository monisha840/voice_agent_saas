import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../client.js";
import { projectMembers, users } from "../schema.js";

export const projectMembersRepository = {
  async listProjectIdsForUser(params: { organizationId: string; userId: string }) {
    const rows = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.organizationId, params.organizationId), eq(projectMembers.userId, params.userId)));
    return rows.map((r) => r.projectId);
  },

  async listForProject(params: { organizationId: string; projectId: string }) {
    return db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.organizationId, params.organizationId), eq(projectMembers.projectId, params.projectId)))
      .orderBy(asc(users.name));
  },

  /** Replaces the project's member list atomically. */
  async replaceForProject(params: { organizationId: string; projectId: string; userIds: string[] }) {
    await db.transaction(async (tx) => {
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.organizationId, params.organizationId), eq(projectMembers.projectId, params.projectId)));
      if (params.userIds.length > 0) {
        await tx.insert(projectMembers).values(
          params.userIds.map((userId) => ({
            organizationId: params.organizationId,
            projectId: params.projectId,
            userId,
          })),
        );
      }
    });
  },

  async removeUserFromOrganization(params: { organizationId: string; userId: string }) {
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.organizationId, params.organizationId), eq(projectMembers.userId, params.userId)));
  },

  async countForProjects(params: { organizationId: string; projectIds: string[] }) {
    if (params.projectIds.length === 0) return 0;
    const rows = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(and(eq(projectMembers.organizationId, params.organizationId), inArray(projectMembers.projectId, params.projectIds)));
    return rows.length;
  },
};
