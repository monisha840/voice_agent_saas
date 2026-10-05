import { eq, desc } from "drizzle-orm";
import { db } from "../client.js";
import { leads, type leadStatusEnum } from "../schema.js";

type LeadStatus = (typeof leadStatusEnum.enumValues)[number];

export const leadsRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(leads).where(eq(leads.id, params.id)).limit(1);
    return rows[0] ?? null;
  },

  async list() {
    return db.select().from(leads).orderBy(desc(leads.createdAt));
  },

  async updateStatus(params: { id: string; status: LeadStatus }) {
    const rows = await db
      .update(leads)
      .set({ status: params.status, updatedAt: new Date() })
      .where(eq(leads.id, params.id))
      .returning();
    return rows[0] ?? null;
  },

  async update(params: {
    id: string;
    requirementConfig?: string;
    budgetMin?: number;
    budgetMax?: number;
    status?: LeadStatus;
  }) {
    const { id, ...fields } = params;
    const rows = await db
      .update(leads)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    return rows[0] ?? null;
  },
};
