import { and, eq, lt } from "drizzle-orm";
import { db } from "../client.js";
import { sessions, users } from "../schema.js";

export const sessionsRepository = {
  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    activeOrganizationId?: string | null;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const rows = await db
      .insert(sessions)
      .values({
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        activeOrganizationId: params.activeOrganizationId ?? null,
        ipAddress: params.ipAddress?.slice(0, 64),
        userAgent: params.userAgent?.slice(0, 512),
      })
      .returning();
    return rows[0];
  },
  /** Session joined with its user; the caller checks expiry and activity. */
  async findWithUserByTokenHash(params: { tokenHash: string }) {
    const rows = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, params.tokenHash))
      .limit(1);
    return rows[0] ?? null;
  },
  async setActiveOrganization(params: { id: string; organizationId: string }) {
    await db.update(sessions).set({ activeOrganizationId: params.organizationId }).where(eq(sessions.id, params.id));
  },
  async touch(params: { id: string; expiresAt: Date }) {
    await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt: params.expiresAt }).where(eq(sessions.id, params.id));
  },
  async deleteByTokenHash(params: { tokenHash: string }) {
    await db.delete(sessions).where(eq(sessions.tokenHash, params.tokenHash));
  },
  async deleteAllForUser(params: { userId: string }) {
    await db.delete(sessions).where(eq(sessions.userId, params.userId));
  },
  async deleteExpired(params: { now: Date }) {
    await db.delete(sessions).where(and(lt(sessions.expiresAt, params.now)));
  },
};
