import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { systemLookups } from "../system-lookups.js";
import { runInTenant } from "../tenant-context.js";
import { agentPhoneNumbers } from "../schema.js";

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
};
