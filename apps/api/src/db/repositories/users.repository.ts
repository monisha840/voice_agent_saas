import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "../client.js";
import { sessions, users } from "../schema.js";

export const usersRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(users).where(eq(users.id, params.id)).limit(1);
    return rows[0] ?? null;
  },
  async findByEmail(params: { email: string }) {
    const rows = await db.select().from(users).where(eq(users.email, params.email.trim().toLowerCase())).limit(1);
    return rows[0] ?? null;
  },
  async create(params: { email: string; name: string; passwordHash: string }) {
    const rows = await db
      .insert(users)
      .values({ email: params.email.trim().toLowerCase(), name: params.name.trim(), passwordHash: params.passwordHash })
      .returning();
    return rows[0];
  },
  async touchLogin(params: { id: string }) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, params.id));
  },
  async setPasswordHash(params: { id: string; passwordHash: string }) {
    await db.update(users).set({ passwordHash: params.passwordHash, updatedAt: new Date() }).where(eq(users.id, params.id));
  },
  async setActive(params: { id: string; isActive: boolean }) {
    await db.update(users).set({ isActive: params.isActive, updatedAt: new Date() }).where(eq(users.id, params.id));
  },

  /**
   * Sets a new password and ends the user's other sessions in ONE transaction: either both happen or neither does,
   * and there is no instant at which the old password is gone but old sessions still work. keepSessionId is the
   * session that made the change (it stays signed in).
   */
  async changePasswordRevokingSessions(params: { id: string; passwordHash: string; keepSessionId?: string | null }) {
    return db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(users).set({ passwordHash: params.passwordHash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, params.id));
      const gone = await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, params.id), params.keepSessionId ? ne(sessions.id, params.keepSessionId) : undefined))
        .returning({ id: sessions.id });
      return gone.length;
    });
  },

  /** Deactivates the account and ends ALL its sessions atomically. */
  async deactivateRevokingSessions(params: { id: string }) {
    return db.transaction(async (tx) => {
      await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, params.id));
      const gone = await tx.delete(sessions).where(eq(sessions.userId, params.id)).returning({ id: sessions.id });
      return gone.length;
    });
  },

  /** Stores a freshly generated, still-unconfirmed TOTP seed (sealed). Does not enable MFA. */
  async setPendingMfaSecret(params: { id: string; secretEnc: string }) {
    await db
      .update(users)
      .set({ mfaSecretEnc: params.secretEnc, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() })
      .where(and(eq(users.id, params.id), isNull(users.mfaEnabledAt)));
  },

  async enableMfa(params: { id: string; step: number }) {
    const rows = await db
      .update(users)
      .set({ mfaEnabledAt: new Date(), mfaLastStep: params.step, updatedAt: new Date() })
      .where(and(eq(users.id, params.id), isNull(users.mfaEnabledAt)))
      .returning({ id: users.id });
    return rows.length === 1;
  },

  /** Records an accepted TOTP step only if it is newer than any accepted before: atomic replay protection. */
  async acceptMfaStep(params: { id: string; step: number }): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ mfaLastStep: params.step })
      .where(and(eq(users.id, params.id), or(isNull(users.mfaLastStep), lt(users.mfaLastStep, params.step))))
      .returning({ id: users.id });
    return rows.length === 1;
  },

  async clearMfa(params: { id: string }) {
    await db
      .update(users)
      .set({ mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() })
      .where(eq(users.id, params.id));
  },
};
