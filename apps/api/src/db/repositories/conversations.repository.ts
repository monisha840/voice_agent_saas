import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { conversations } from "../schema.js";

export interface TranscriptTurn {
  speaker: "ai" | "lead";
  text: string;
  timestamp: string;
}

export const conversationsRepository = {
  async findByCallId(params: { callId: string }) {
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.callId, params.callId))
      .limit(1);
    return rows[0] ?? null;
  },

  async createForCall(params: { callId: string }) {
    const rows = await db
      .insert(conversations)
      .values({ callId: params.callId, transcript: [] })
      .returning();
    return rows[0];
  },

  /** Appends a single turn to the transcript (incremental persistence). */
  async appendTurn(params: { callId: string; turn: TranscriptTurn }) {
    const existing = await this.findByCallId({ callId: params.callId });
    const current = (existing?.transcript as TranscriptTurn[] | null) ?? [];
    const updated = [...current, params.turn];

    const rows = await db
      .update(conversations)
      .set({ transcript: updated })
      .where(eq(conversations.callId, params.callId))
      .returning();
    return rows[0] ?? null;
  },

  async setSummary(params: {
    callId: string;
    summary: string;
    qualification: Record<string, unknown>;
  }) {
    const rows = await db
      .update(conversations)
      .set({ summary: params.summary, qualification: params.qualification })
      .where(eq(conversations.callId, params.callId))
      .returning();
    return rows[0] ?? null;
  },
};
