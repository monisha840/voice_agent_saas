import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { siteVisits } from "../schema.js";

export const siteVisitsRepository = {
  async listByLead(params: { leadId: string }) {
    return db.select().from(siteVisits).where(eq(siteVisits.leadId, params.leadId));
  },

  async create(params: { leadId: string; projectId: string; scheduledAt: Date }) {
    const rows = await db
      .insert(siteVisits)
      .values({
        leadId: params.leadId,
        projectId: params.projectId,
        scheduledAt: params.scheduledAt,
        status: "booked",
      })
      .returning();
    return rows[0];
  },
};
