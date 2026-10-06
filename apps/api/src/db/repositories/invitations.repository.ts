import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../client.js";
import { invitations, memberships, users } from "../schema.js";

type OrgRole = (typeof invitations.$inferSelect)["role"];

export const invitationsRepository = {
  async create(params: {
    organizationId: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    invitedByUserId: string | null;
    expiresAt: Date;
  }) {
    const rows = await db
      .insert(invitations)
      .values({ ...params, email: params.email.trim().toLowerCase() })
      .returning();
    return rows[0];
  },

  /** SYSTEM (public accept-invite endpoint): the token is the credential, so no organization is known yet. */
  async findUsableByTokenHashAnyOrg(params: { tokenHash: string; now: Date }) {
    const rows = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, params.tokenHash),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, params.now),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listPending(params: { organizationId: string; now: Date }) {
    return db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, params.organizationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, params.now),
        ),
      )
      .orderBy(desc(invitations.createdAt));
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.organizationId, params.organizationId), eq(invitations.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async markAccepted(params: { id: string }) {
    await db.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, params.id));
  },

  /** Revokes every still-pending invitation for an email (re-inviting replaces the old link). */
  async revokePendingForEmail(params: { organizationId: string; email: string }) {
    await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.organizationId, params.organizationId),
          eq(invitations.email, params.email.trim().toLowerCase()),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
  },

  /**
   * Accepts an invitation atomically: the conditional UPDATE claims it (so two
   * concurrent accepts cannot both win), then the user (if new) and the
   * membership are created in the same transaction. Returns null when the
   * invitation was no longer usable.
   */
  async accept(params: {
    invitation: { id: string; organizationId: string; role: OrgRole };
    existingUserId?: string;
    newUser?: { email: string; name: string; passwordHash: string };
    now: Date;
  }) {
    return db.transaction(async (tx) => {
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: params.now })
        .where(
          and(
            eq(invitations.id, params.invitation.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, params.now),
          ),
        )
        .returning({ id: invitations.id });
      if (claimed.length === 0) return null;
      let userId = params.existingUserId;
      if (!userId && params.newUser) {
        const rows = await tx
          .insert(users)
          .values({ ...params.newUser, email: params.newUser.email.trim().toLowerCase(), name: params.newUser.name.trim() })
          .returning({ id: users.id });
        userId = rows[0].id;
      }
      if (!userId) throw new Error("accept requires an existing or new user");
      await tx.insert(memberships).values({ organizationId: params.invitation.organizationId, userId, role: params.invitation.role });
      return { userId };
    });
  },

  async revoke(params: { organizationId: string; id: string }) {
    const rows = await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.organizationId, params.organizationId), eq(invitations.id, params.id), isNull(invitations.acceptedAt)))
      .returning();
    return rows[0] ?? null;
  },
};
