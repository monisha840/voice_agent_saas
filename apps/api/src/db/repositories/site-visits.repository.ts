import { and, desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { siteVisits } from "../schema.js";

/** Every method requires an organizationId and filters by it. */
export const siteVisitsRepository = {
  async list(params: { organizationId: string }) {
    return db
      .select()
      .from(siteVisits)
      .where(eq(siteVisits.organizationId, params.organizationId))
      .orderBy(desc(siteVisits.scheduledAt));
  },

  async findById(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(siteVisits)
      .where(and(eq(siteVisits.organizationId, params.organizationId), eq(siteVisits.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByLead(params: { organizationId: string; leadId: string }) {
    return db
      .select()
      .from(siteVisits)
      .where(and(eq(siteVisits.organizationId, params.organizationId), eq(siteVisits.leadId, params.leadId)));
  },

  async create(params: { organizationId: string; leadId: string; projectId: string; scheduledAt: Date }) {
    const rows = await db
      .insert(siteVisits)
      .values({
        organizationId: params.organizationId,
        leadId: params.leadId,
        projectId: params.projectId,
        scheduledAt: params.scheduledAt,
        status: "booked",
      })
      .returning();
    return rows[0];
  },
};
