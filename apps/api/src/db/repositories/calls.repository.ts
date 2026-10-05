import { eq, desc } from "drizzle-orm";
import { db } from "../client.js";
import { calls, type callStatusEnum } from "../schema.js";

type CallStatus = (typeof callStatusEnum.enumValues)[number];

export const callsRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(calls).where(eq(calls.id, params.id)).limit(1);
    return rows[0] ?? null;
  },

  async findByProviderCallId(params: { providerCallId: string }) {
    const rows = await db
      .select()
      .from(calls)
      .where(eq(calls.providerCallId, params.providerCallId))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByLead(params: { leadId: string }) {
    return db
      .select()
      .from(calls)
      .where(eq(calls.leadId, params.leadId))
      .orderBy(desc(calls.createdAt));
  },

  async create(params: { leadId: string; status: CallStatus }) {
    const rows = await db
      .insert(calls)
      .values({ leadId: params.leadId, status: params.status })
      .returning();
    return rows[0];
  },

  async setProviderCallId(params: { id: string; providerCallId: string }) {
    const rows = await db
      .update(calls)
      .set({ providerCallId: params.providerCallId })
      .where(eq(calls.id, params.id))
      .returning();
    return rows[0] ?? null;
  },

  async updateStatus(params: {
    id: string;
    status: CallStatus;
    startedAt?: Date;
    endedAt?: Date;
    recordingUrl?: string;
  }) {
    const rows = await db
      .update(calls)
      .set({
        status: params.status,
        ...(params.startedAt ? { startedAt: params.startedAt } : {}),
        ...(params.endedAt ? { endedAt: params.endedAt } : {}),
        ...(params.recordingUrl ? { recordingUrl: params.recordingUrl } : {}),
      })
      .where(eq(calls.id, params.id))
      .returning();
    return rows[0] ?? null;
  },
};
