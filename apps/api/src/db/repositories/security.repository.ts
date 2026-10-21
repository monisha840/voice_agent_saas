import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { authThrottle, mfaRecoveryCodes, rateLimitBuckets, securityEvents, streamClaims, streamGrants, streamTokenUses } from "../schema.js";

/** Append-only: no update or delete exists for the runtime role (migration 0013 revokes it). */
export const securityEventsRepository = {
  async insert(row: typeof securityEvents.$inferInsert) {
    await db.insert(securityEvents).values(row);
  },

  async listForOrganization(params: { organizationId: string; limit: number; before?: Date; eventType?: string }) {
    const conds: SQL[] = [eq(securityEvents.organizationId, params.organizationId)];
    if (params.before) conds.push(lt(securityEvents.createdAt, params.before));
    if (params.eventType) conds.push(eq(securityEvents.eventType, params.eventType));
    return db
      .select()
      .from(securityEvents)
      .where(and(...conds))
      .orderBy(desc(securityEvents.createdAt))
      .limit(params.limit);
  },
};

/**
 * Retention is the only way security_events rows leave. The runtime role has no DELETE; this calls the SECURITY
 * DEFINER function from migration 0015 (owned by voice_retention). Cutoffs are absolute: rows strictly older than
 * the category's cutoff are removed, at most `batch` per call.
 */
export const securityEventRetentionRepository = {
  async purge(params: { cutoffs: Record<string, Date>; batch: number; archive: boolean }): Promise<Record<string, number>> {
    const cutoffs = Object.fromEntries(Object.entries(params.cutoffs).map(([k, v]) => [k, v.toISOString()]));
    const rows = (await db.execute(
      sql`select category, purged from app_purge_security_events(${JSON.stringify(cutoffs)}::jsonb, ${params.batch}::int, ${params.archive}::boolean)`,
    )) as unknown as Array<{ category: string; purged: number }>;
    return Object.fromEntries(rows.map((r) => [r.category, Number(r.purged)]));
  },
};

export const authThrottleRepository = {
  async get(keys: string[]) {
    if (keys.length === 0) return [];
    return db.select().from(authThrottle).where(inArray(authThrottle.key, keys));
  },

  /** Counts one failure in the key's window (a stale window starts over). Returns the failures in the window. */
  async bump(params: { key: string; windowMs: number }): Promise<number> {
    const rows = await db.execute(sql`
      insert into auth_throttle (key, failures, window_started_at, updated_at)
      values (${params.key}, 1, now(), now())
      on conflict (key) do update set
        failures = case when auth_throttle.window_started_at < now() - (${params.windowMs}::int * interval '1 millisecond')
                        then 1 else auth_throttle.failures + 1 end,
        window_started_at = case when auth_throttle.window_started_at < now() - (${params.windowMs}::int * interval '1 millisecond')
                                 then now() else auth_throttle.window_started_at end,
        locked_until = case when auth_throttle.window_started_at < now() - (${params.windowMs}::int * interval '1 millisecond')
                            then null else auth_throttle.locked_until end,
        updated_at = now()
      returning failures`);
    return Number((rows as unknown as Array<{ failures: number }>)[0].failures);
  },

  async lockUntil(params: { key: string; until: Date }) {
    await db.update(authThrottle).set({ lockedUntil: params.until }).where(eq(authThrottle.key, params.key));
  },

  async clear(key: string) {
    await db.delete(authThrottle).where(eq(authThrottle.key, key));
  },

  async deleteStale(params: { before: Date }) {
    await db.delete(authThrottle).where(lt(authThrottle.updatedAt, params.before));
  },
};

export const streamTokenUsesRepository = {
  /** Counts one connection against a token. Returns how many times it has now been used (1 on first use). */
  async consume(params: { jti: string; callId: string; expiresAt: Date }): Promise<number> {
    const rows = await db.execute(sql`
      insert into stream_token_uses (jti, call_id, uses, expires_at)
      values (${params.jti}, ${params.callId}::uuid, 1, ${params.expiresAt.toISOString()}::timestamptz)
      on conflict (jti) do update set uses = stream_token_uses.uses + 1
      returning uses`);
    return Number((rows as unknown as Array<{ uses: number }>)[0].uses);
  },

  async deleteExpired(params: { before: Date }) {
    await db.delete(streamTokenUses).where(lt(streamTokenUses.expiresAt, params.before));
  },
};

/** Shared "one stream per call" claim across API instances (table stream_claims). */
export const streamClaimsRepository = {
  /**
   * Atomically claims the call's stream. Succeeds when nobody holds it, or the holder's heartbeat is older than
   * `staleMs` (dead instance). Two simultaneous callers: exactly one row is returned.
   */
  async claim(params: { callId: string; instanceId: string; staleMs: number }): Promise<boolean> {
    const rows = await db.execute(sql`
      insert into stream_claims (call_id, instance_id, claimed_at, heartbeat_at)
      values (${params.callId}::uuid, ${params.instanceId}, now(), now())
      on conflict (call_id) do update set instance_id = excluded.instance_id, claimed_at = now(), heartbeat_at = now()
        where stream_claims.heartbeat_at < now() - (${params.staleMs}::int * interval '1 millisecond')
      returning call_id`);
    return (rows as unknown as unknown[]).length === 1;
  },

  /** Refreshes the claim; false when this instance no longer holds it (taken over after a stall). */
  async heartbeat(params: { callId: string; instanceId: string }): Promise<boolean> {
    const rows = await db
      .update(streamClaims)
      .set({ heartbeatAt: sql`now()` })
      .where(and(eq(streamClaims.callId, params.callId), eq(streamClaims.instanceId, params.instanceId)))
      .returning({ callId: streamClaims.callId });
    return rows.length === 1;
  },

  /** Releases only a claim this instance holds (never one that was taken over). */
  async release(params: { callId: string; instanceId: string }) {
    await db.delete(streamClaims).where(and(eq(streamClaims.callId, params.callId), eq(streamClaims.instanceId, params.instanceId)));
  },

  async deleteStale(params: { before: Date }) {
    await db.delete(streamClaims).where(lt(streamClaims.heartbeatAt, params.before));
  },
};

/** Per-call stream grants (table stream_grants). Only the SHA-256 of the grant is ever stored or queried. */
export const streamGrantsRepository = {
  async insert(params: { grantHash: string; callId: string; providerCallId: string; expiresAt: Date }) {
    await db.insert(streamGrants).values(params);
  },

  /**
   * Atomically counts one connection against a live grant. One statement: unknown, expired and exhausted grants all
   * return null, and concurrent connections cannot exceed `maxUses`.
   */
  async consume(params: { grantHash: string; maxUses: number }): Promise<{ callId: string; providerCallId: string; uses: number } | null> {
    const rows = (await db.execute(sql`
      update stream_grants set uses = uses + 1
      where grant_hash = ${params.grantHash} and expires_at > now() and uses < ${params.maxUses}::int
      returning call_id, provider_call_id, uses`)) as unknown as Array<{ call_id: string; provider_call_id: string; uses: number }>;
    if (rows.length !== 1) return null;
    return { callId: rows[0].call_id, providerCallId: rows[0].provider_call_id, uses: Number(rows[0].uses) };
  },

  /** Why a grant was not consumable, for the denial reason only. */
  async diagnose(params: { grantHash: string }): Promise<"unknown" | "expired" | "exhausted"> {
    const rows = await db.select().from(streamGrants).where(eq(streamGrants.grantHash, params.grantHash)).limit(1);
    if (rows.length === 0) return "unknown";
    return rows[0].expiresAt.getTime() <= Date.now() ? "expired" : "exhausted";
  },

  async deleteExpired(params: { before: Date }) {
    await db.delete(streamGrants).where(lt(streamGrants.expiresAt, params.before));
  },
};

export const mfaRecoveryCodesRepository = {
  /** Replaces every code of the user atomically (regeneration invalidates the previous set). */
  async replaceAll(params: { userId: string; codeHashes: string[] }) {
    await db.transaction(async (tx) => {
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, params.userId));
      if (params.codeHashes.length > 0) {
        await tx.insert(mfaRecoveryCodes).values(params.codeHashes.map((codeHash) => ({ userId: params.userId, codeHash })));
      }
    });
  },

  /** Marks one unused code as used. Returns false when it does not exist or was already used (single use). */
  async consume(params: { userId: string; codeHash: string; now: Date }): Promise<boolean> {
    const rows = await db
      .update(mfaRecoveryCodes)
      .set({ usedAt: params.now })
      .where(and(eq(mfaRecoveryCodes.userId, params.userId), eq(mfaRecoveryCodes.codeHash, params.codeHash), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    return rows.length === 1;
  },

  async countUnused(params: { userId: string }): Promise<number> {
    const rows = await db
      .select({ id: mfaRecoveryCodes.id })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, params.userId), isNull(mfaRecoveryCodes.usedAt)));
    return rows.length;
  },

  async deleteAll(params: { userId: string }) {
    await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, params.userId));
  },
};

export const rateLimitBucketsRepository = {
  /**
   * Counts one hit in the key's fixed window with ONE atomic upsert (database clock, so instances need no clock sync).
   * A window that has expired starts over at 1. Returns the hits in the window (this one included) and the whole
   * seconds until the window ends. The count saturates so a flood cannot overflow the column.
   */
  async hit(params: { key: string; windowMs: number }): Promise<{ count: number; retryAfterSec: number }> {
    const rows = (await db.execute(sql`
      insert into rate_limit_buckets as b (key, window_start, count)
      values (${params.key}, now(), 1)
      on conflict (key) do update set
        count = case when b.window_start <= now() - (${params.windowMs}::int * interval '1 millisecond')
                     then 1 else least(b.count + 1, 1000000000) end,
        window_start = case when b.window_start <= now() - (${params.windowMs}::int * interval '1 millisecond')
                            then now() else b.window_start end
      returning b.count as count,
        greatest(1, ceil(extract(epoch from (b.window_start + (${params.windowMs}::int * interval '1 millisecond') - now()))))::int as retry_after`)) as unknown as Array<{
      count: number;
      retry_after: number;
    }>;
    return { count: Number(rows[0].count), retryAfterSec: Number(rows[0].retry_after) };
  },

  /** Deletes up to `batch` rows whose window started before `before`. Returns how many were removed. */
  async deleteExpired(params: { before: Date; batch: number }): Promise<number> {
    const rows = (await db.execute(sql`
      delete from rate_limit_buckets where key in (
        select key from rate_limit_buckets where window_start < ${params.before.toISOString()}::timestamptz limit ${params.batch}::int
      ) returning 1`)) as unknown as unknown[];
    return rows.length;
  },

  /** Test helper. */
  async deleteAll() {
    await db.delete(rateLimitBuckets);
  },
};
