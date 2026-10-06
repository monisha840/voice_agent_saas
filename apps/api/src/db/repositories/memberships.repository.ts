import { and, asc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { leads, memberships, organizations, projectMembers, users } from "../schema.js";

type OrgRole = (typeof memberships.$inferSelect)["role"];

export const membershipsRepository = {
  /** All organizations a user belongs to (oldest membership first), with their role. */
  async listForUser(params: { userId: string }) {
    return db
      .select({
        organizationId: memberships.organizationId,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(and(eq(memberships.userId, params.userId), eq(organizations.status, "active")))
      .orderBy(asc(memberships.createdAt));
  },

  async findByUserAndOrg(params: { userId: string; organizationId: string }) {
    const rows = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, params.userId), eq(memberships.organizationId, params.organizationId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async create(params: { organizationId: string; userId: string; role: OrgRole }) {
    const rows = await db.insert(memberships).values(params).returning();
    return rows[0];
  },

  /** The organization's team (members with their user details). */
  async listForOrg(params: { organizationId: string }) {
    return db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, params.organizationId))
      .orderBy(asc(memberships.createdAt));
  },

  async updateRole(params: { organizationId: string; userId: string; role: OrgRole }) {
    const rows = await db
      .update(memberships)
      .set({ role: params.role })
      .where(and(eq(memberships.organizationId, params.organizationId), eq(memberships.userId, params.userId)))
      .returning();
    return rows[0] ?? null;
  },

  async remove(params: { organizationId: string; userId: string }) {
    const rows = await db
      .delete(memberships)
      .where(and(eq(memberships.organizationId, params.organizationId), eq(memberships.userId, params.userId)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Removes a member from the organization (the user account stays): drops their
   * project assignments and unassigns their leads, in one transaction.
   */
  async removeWithCleanup(params: { organizationId: string; userId: string }) {
    return db.transaction(async (tx) => {
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.organizationId, params.organizationId), eq(projectMembers.userId, params.userId)));
      await tx
        .update(leads)
        .set({ assignedUserId: null, updatedAt: new Date() })
        .where(and(eq(leads.organizationId, params.organizationId), eq(leads.assignedUserId, params.userId)));
      const rows = await tx
        .delete(memberships)
        .where(and(eq(memberships.organizationId, params.organizationId), eq(memberships.userId, params.userId)))
        .returning();
      return rows[0] ?? null;
    });
  },

  async countOwners(params: { organizationId: string }) {
    const rows = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, params.organizationId), eq(memberships.role, "OWNER")));
    return rows.length;
  },
};
