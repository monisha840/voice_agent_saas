import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { systemLookups } from "../system-lookups.js";
import { runInTenant } from "../tenant-context.js";
import { agentPhoneNumbers, agents, calls } from "../schema.js";

export const agentPhoneNumbersRepository = {
  /**
   * SYSTEM ONLY: an inbound call arrives with no login, knowing only the dialed number. Numbers are globally
   * unique, so this is unambiguous; the row carries the organization the call then belongs to.
   */
  async findByNumberAnyOrg(params: { phoneNumber: string }) {
    const organizationId = await systemLookups.phoneNumberOrg(params.phoneNumber);
    if (!organizationId) return null;
    return runInTenant({ organizationId }, async () => {
      const rows = await db
        .select()
        .from(agentPhoneNumbers)
        .where(and(eq(agentPhoneNumbers.organizationId, organizationId), eq(agentPhoneNumbers.phoneNumber, params.phoneNumber)))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  async listForAgent(params: { organizationId: string; agentId: string }) {
    return db
      .select()
      .from(agentPhoneNumbers)
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.agentId, params.agentId)))
      .orderBy(agentPhoneNumbers.createdAt);
  },

  async add(params: { organizationId: string; agentId: string; phoneNumber: string; label?: string | null }) {
    const rows = await db
      .insert(agentPhoneNumbers)
      .values({
        organizationId: params.organizationId,
        agentId: params.agentId,
        phoneNumber: params.phoneNumber,
        label: params.label ?? null,
      })
      .returning();
    return rows[0];
  },

  async remove(params: { organizationId: string; agentId: string; id: string }) {
    const rows = await db
      .delete(agentPhoneNumbers)
      .where(
        and(
          eq(agentPhoneNumbers.organizationId, params.organizationId),
          eq(agentPhoneNumbers.agentId, params.agentId),
          eq(agentPhoneNumbers.id, params.id),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  // -------------------------------------------------------------------------------------------------------------
  // Number management (modules/numbers). Every method is addressed by organizationId.
  // -------------------------------------------------------------------------------------------------------------

  /** The organization's numbers with the assigned agent's name and status. */
  async listForOrg(params: { organizationId: string }) {
    return db
      .select({ number: agentPhoneNumbers, agentName: agents.name, agentStatus: agents.status })
      .from(agentPhoneNumbers)
      .innerJoin(agents, and(eq(agents.organizationId, agentPhoneNumbers.organizationId), eq(agents.id, agentPhoneNumbers.agentId)))
      .where(eq(agentPhoneNumbers.organizationId, params.organizationId))
      .orderBy(agentPhoneNumbers.createdAt);
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select({ number: agentPhoneNumbers, agentName: agents.name, agentStatus: agents.status })
      .from(agentPhoneNumbers)
      .innerJoin(agents, and(eq(agents.organizationId, agentPhoneNumbers.organizationId), eq(agents.id, agentPhoneNumbers.agentId)))
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** This organization's row for a number (another organization's numbers are invisible here). */
  async findByNumber(params: { organizationId: string; phoneNumber: string }) {
    const rows = await db
      .select()
      .from(agentPhoneNumbers)
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.phoneNumber, params.phoneNumber)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Changes routing. With `expectedAgentId` the update applies only if the number still routes to that agent, so two
   * people changing the same number cannot silently overwrite each other (null = it changed underneath).
   */
  async updateRouting(params: {
    organizationId: string;
    id: string;
    expectedAgentId?: string;
    set: { agentId?: string; label?: string | null; routingEnabled?: boolean };
  }) {
    const conditions = [eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)];
    if (params.expectedAgentId) conditions.push(eq(agentPhoneNumbers.agentId, params.expectedAgentId));
    const rows = await db
      .update(agentPhoneNumbers)
      .set({ ...params.set, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return rows[0] ?? null;
  },

  async removeById(params: { organizationId: string; id: string }) {
    const rows = await db
      .delete(agentPhoneNumbers)
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  async recordInboundAccepted(params: { organizationId: string; id: string }) {
    await db
      .update(agentPhoneNumbers)
      .set({ lastInboundAt: new Date() })
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)));
  },

  /** Counts a refused inbound attempt once per provider call: a retried webhook for the same call is not counted again. */
  async recordInboundRefused(params: { organizationId: string; id: string; reason: string; providerCallId?: string | null }) {
    const callId = params.providerCallId ?? null;
    const conditions = [eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)];
    if (callId) {
      const notSame = or(isNull(agentPhoneNumbers.lastRefusedCallId), ne(agentPhoneNumbers.lastRefusedCallId, callId));
      if (notSame) conditions.push(notSame);
    }
    await db
      .update(agentPhoneNumbers)
      .set({
        refusedCount: sql`${agentPhoneNumbers.refusedCount} + 1`,
        lastRefusedAt: new Date(),
        lastRefusedReason: params.reason.slice(0, 40),
        lastRefusedCallId: callId,
      })
      .where(and(...conditions));
  },

  async setProviderCheck(params: { organizationId: string; id: string; status: string; detail: string }) {
    const rows = await db
      .update(agentPhoneNumbers)
      .set({ providerStatus: params.status, providerDetail: params.detail.slice(0, 300), providerCheckedAt: new Date() })
      .where(and(eq(agentPhoneNumbers.organizationId, params.organizationId), eq(agentPhoneNumbers.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  /** Inbound call counts per line since `since`: total, failed, in progress, last call time. */
  async lineStats(params: { organizationId: string; lineNumbers: string[]; since: Date }) {
    if (params.lineNumbers.length === 0) return [];
    return db
      .select({
        lineNumber: calls.lineNumber,
        total: sql<number>`count(*)::int`,
        failed: sql<number>`(count(*) filter (where ${calls.status} = 'failed'))::int`,
        live: sql<number>`(count(*) filter (where ${calls.status} in ('initiating','ringing','in_progress')))::int`,
        lastCallAt: sql<string | null>`max(${calls.createdAt})`,
      })
      .from(calls)
      .where(
        and(
          eq(calls.organizationId, params.organizationId),
          inArray(calls.lineNumber, params.lineNumbers),
          gte(calls.createdAt, params.since),
        ),
      )
      .groupBy(calls.lineNumber);
  },

  /** Most recent calls on a line (optionally failed ones only), newest first. */
  async callsOnLine(params: { organizationId: string; lineNumber: string; limit: number; failedOnly?: boolean }) {
    const conditions = [eq(calls.organizationId, params.organizationId), eq(calls.lineNumber, params.lineNumber)];
    if (params.failedOnly) conditions.push(eq(calls.status, "failed"));
    return db
      .select({
        id: calls.id,
        status: calls.status,
        callType: calls.callType,
        counterpartyNumber: calls.counterpartyNumber,
        agentId: calls.agentId,
        agentName: agents.name,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        createdAt: calls.createdAt,
      })
      .from(calls)
      .innerJoin(agents, and(eq(agents.organizationId, calls.organizationId), eq(agents.id, calls.agentId)))
      .where(and(...conditions))
      .orderBy(desc(calls.createdAt))
      .limit(params.limit);
  },
};
