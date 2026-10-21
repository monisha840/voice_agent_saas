/**
 * Data access for `account_tokens` (migration 0026): the single-use, time-boxed credentials behind "forgot
 * password" and e-mail verification.
 *
 * Identity data, addressed by token hash or user id - never by organization. The table carries no organization_id
 * and no row-level-security policy, for the reason spelled out at length in the migration and in schema.ts: these
 * lookups happen with NO session and NO tenant context, where every policy predicate in this database
 * (app_current_org() / app_current_user()) is NULL and would hide the row. The isolation that matters here is
 * carried by the credential, not by a policy: only sha256(token) is ever stored, `used_at` makes a row single-use,
 * `expires_at` bounds its life, and nothing can list rows it does not already hold the token for.
 *
 * Every method below is written so that "no such token", "expired" and "already used" are the SAME outcome (no
 * row), which is what lets the service answer identically in all three cases.
 */
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { accountTokens, users } from "../../db/schema.js";

export type AccountTokenPurpose = "password_reset" | "email_verification";

export interface AccountTokenRow {
  id: string;
  userId: string;
  purpose: AccountTokenPurpose;
  email: string;
  expiresAt: Date;
  createdAt: Date;
}

const projection = {
  id: accountTokens.id,
  userId: accountTokens.userId,
  purpose: accountTokens.purpose,
  email: accountTokens.email,
  expiresAt: accountTokens.expiresAt,
  createdAt: accountTokens.createdAt,
};

export const accountTokensRepository = {
  /** Mints a token row. The caller holds the plaintext token; only its hash reaches the database. */
  async create(params: {
    userId: string;
    purpose: AccountTokenPurpose;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    requestedIp?: string | null;
  }): Promise<AccountTokenRow> {
    const rows = await db
      .insert(accountTokens)
      .values({
        userId: params.userId,
        purpose: params.purpose,
        email: params.email.trim().toLowerCase(),
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        requestedIp: params.requestedIp?.slice(0, 64) ?? null,
      })
      .returning(projection);
    return rows[0] as AccountTokenRow;
  },

  /**
   * Finds a token that is still usable: right purpose, not consumed, not expired. Returns null for every other
   * case (unknown hash, wrong purpose, spent, expired) so the caller cannot tell them apart.
   *
   * This is a read, NOT a consume: the caller validates the new password first, so a rejected password does not
   * burn the customer's only link. `consume` below is the atomic guard that actually spends it.
   */
  async findUsableByTokenHash(params: { tokenHash: string; purpose: AccountTokenPurpose; now: Date }): Promise<AccountTokenRow | null> {
    const rows = await db
      .select(projection)
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.tokenHash, params.tokenHash),
          eq(accountTokens.purpose, params.purpose),
          isNull(accountTokens.usedAt),
          gt(accountTokens.expiresAt, params.now),
        ),
      )
      .limit(1);
    return (rows[0] as AccountTokenRow | undefined) ?? null;
  },

  /**
   * Spends a token. ONE statement, so it is atomic under concurrency: two simultaneous requests carrying the same
   * token both match the row, but only the first UPDATE sees `used_at IS NULL` and returns a row. The loser gets
   * null and is refused exactly like an unknown token. That is what makes the token genuinely single-use rather
   * than merely marked-used-afterwards.
   */
  async consume(params: { tokenHash: string; purpose: AccountTokenPurpose; now: Date }): Promise<AccountTokenRow | null> {
    const rows = await db
      .update(accountTokens)
      .set({ usedAt: params.now })
      .where(
        and(
          eq(accountTokens.tokenHash, params.tokenHash),
          eq(accountTokens.purpose, params.purpose),
          isNull(accountTokens.usedAt),
          gt(accountTokens.expiresAt, params.now),
        ),
      )
      .returning(projection);
    return (rows[0] as AccountTokenRow | undefined) ?? null;
  },

  /**
   * Burns every other outstanding token of this purpose for the user. Called when a new one is issued (only the
   * newest link works) and again when one is spent (a reset mints a password change, so any link an attacker
   * requested in parallel dies with it). Returns how many were invalidated.
   */
  async supersedeOutstanding(params: { userId: string; purpose: AccountTokenPurpose; now: Date; exceptId?: string }): Promise<number> {
    const rows = await db
      .update(accountTokens)
      .set({ usedAt: params.now })
      .where(
        and(
          eq(accountTokens.userId, params.userId),
          eq(accountTokens.purpose, params.purpose),
          isNull(accountTokens.usedAt),
          params.exceptId ? ne(accountTokens.id, params.exceptId) : undefined,
        ),
      )
      .returning({ id: accountTokens.id });
    return rows.length;
  },

  /**
   * Removes rows that can no longer be used (expired, or spent long enough ago to be of no forensic interest).
   * Bounded, like the other janitor queries, so it never takes a long lock.
   */
  async deleteUnusable(params: { before: Date; batch: number }): Promise<number> {
    // The id subquery keeps the batch bound (same shape as rateLimitBucketsRepository.deleteExpired). Timestamps go
    // in as explicit ISO text: a raw Date in a sql`` template is not serialized by the driver.
    const cutoff = params.before.toISOString();
    const rows = (await db.execute(sql`
      delete from account_tokens where id in (
        select id from account_tokens
        where expires_at < ${cutoff}::timestamptz or (used_at is not null and used_at < ${cutoff}::timestamptz)
        limit ${params.batch}::int
      ) returning 1`)) as unknown as unknown[];
    return rows.length;
  },

  /** TEST ONLY: ages a token so expiry can be exercised without waiting. */
  async expireForTest(params: { tokenHash: string }): Promise<void> {
    await db
      .update(accountTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(accountTokens.tokenHash, params.tokenHash));
  },

  /** Diagnostics only: how many unused, unexpired tokens of a purpose a user holds. */
  async countOutstanding(params: { userId: string; purpose: AccountTokenPurpose; now: Date }): Promise<number> {
    const rows = await db
      .select({ id: accountTokens.id })
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.userId, params.userId),
          eq(accountTokens.purpose, params.purpose),
          isNull(accountTokens.usedAt),
          gt(accountTokens.expiresAt, params.now),
        ),
      );
    return rows.length;
  },
};

/**
 * The one bit of `users` this module writes: the verified-address stamp. Identity data, addressed by user id,
 * exactly like every other method of users.repository.ts.
 */
export const emailVerificationRepository = {
  /**
   * Stamps the address as verified. Guarded on the address still matching AND on the stamp still being null, so a
   * replayed confirmation cannot move the timestamp and a token minted for an old address cannot verify a new one.
   * Returns true only when this call is the one that verified it.
   */
  async markVerified(params: { userId: string; email: string; at: Date }): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ emailVerifiedAt: params.at, updatedAt: params.at })
      .where(and(eq(users.id, params.userId), eq(users.email, params.email.trim().toLowerCase()), isNull(users.emailVerifiedAt)))
      .returning({ id: users.id });
    return rows.length === 1;
  },
};
