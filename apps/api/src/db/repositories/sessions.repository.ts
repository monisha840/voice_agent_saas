import { and, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
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
    /** The second factor was satisfied (or is not applicable) at creation. Null = still pending. */
    mfaVerifiedAt?: Date | null;
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
        mfaVerifiedAt: params.mfaVerifiedAt ?? null,
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
  /** The user's live sessions, newest activity first. */
  async listLiveForUser(params: { userId: string; now: Date }) {
    return db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, params.userId), gt(sessions.expiresAt, params.now)))
      .orderBy(desc(sessions.lastSeenAt));
  },
  /** Deletes one session, only if it belongs to the user. Returns whether anything was deleted. */
  async deleteByIdForUser(params: { id: string; userId: string }): Promise<boolean> {
    const rows = await db
      .delete(sessions)
      .where(and(eq(sessions.id, params.id), eq(sessions.userId, params.userId)))
      .returning({ id: sessions.id });
    return rows.length === 1;
  },
  async deleteOthersForUser(params: { userId: string; keepId: string }): Promise<number> {
    const rows = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, params.userId), ne(sessions.id, params.keepId)))
      .returning({ id: sessions.id });
    return rows.length;
  },
  /** The second factor passed: verified now, and the session gets its normal lifetime (capped by its absolute age). */
  async completeMfa(params: { id: string; ttlMs: number; maxAgeMs: number }) {
    await db
      .update(sessions)
      .set({
        mfaVerifiedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: sql`least(now() + (${params.ttlMs}::bigint * interval '1 millisecond'), ${sessions.createdAt} + (${params.maxAgeMs}::bigint * interval '1 millisecond'))`,
      })
      .where(eq(sessions.id, params.id));
  },
  async markReauthenticated(params: { id: string }) {
    await db.update(sessions).set({ lastAuthAt: new Date() }).where(eq(sessions.id, params.id));
  },
  async deleteExpired(params: { now: Date }) {
    await db.delete(sessions).where(and(lt(sessions.expiresAt, params.now)));
  },
};
