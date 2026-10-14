import { and, eq, isNull } from "drizzle-orm";
import { db } from "../client.js";
import { conversations } from "../schema.js";

export interface TranscriptTurn {
  speaker: "ai" | "lead";
  text: string;
  timestamp: string;
}

/** Every method requires an organizationId and filters by it. */
export const conversationsRepository = {
  async findByCallId(params: { organizationId: string; callId: string }) {
    const rows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.callId, params.callId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async createForCall(params: { organizationId: string; callId: string }) {
    const rows = await db
      .insert(conversations)
      .values({ organizationId: params.organizationId, callId: params.callId, transcript: [] })
      .returning();
    return rows[0];
  },

  /** Appends a single turn to the transcript (incremental persistence). */
  async appendTurn(params: { organizationId: string; callId: string; turn: TranscriptTurn }) {
    const existing = await this.findByCallId({ organizationId: params.organizationId, callId: params.callId });
    const current = (existing?.transcript as TranscriptTurn[] | null) ?? [];
    const updated = [...current, params.turn];
    const rows = await db
      .update(conversations)
      .set({ transcript: updated })
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.callId, params.callId)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Removes the last transcript turn, but only if it is exactly this turn (same speaker and text): the agent decided the
   * words were background talk, not part of the conversation. A different last turn is left alone.
   */
  async removeLastTurnIf(params: { organizationId: string; callId: string; speaker: TranscriptTurn["speaker"]; text: string }) {
    const existing = await this.findByCallId({ organizationId: params.organizationId, callId: params.callId });
    const current = (existing?.transcript as TranscriptTurn[] | null) ?? [];
    const last = current[current.length - 1];
    if (!last || last.speaker !== params.speaker || last.text !== params.text) return false;
    await db
      .update(conversations)
      .set({ transcript: current.slice(0, -1) })
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.callId, params.callId)));
    return true;
  },

  async setSummary(params: {
    organizationId: string;
    callId: string;
    summary: string;
    qualification: Record<string, unknown>;
  }) {
    const rows = await db
      .update(conversations)
      .set({ summary: params.summary, qualification: params.qualification })
      .where(and(eq(conversations.organizationId, params.organizationId), eq(conversations.callId, params.callId)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Stores the summary only if none exists yet. Returns null if another
   * finalization already wrote one (idempotent post-call pipeline).
   */
  async setSummaryIfAbsent(params: {
    organizationId: string;
    callId: string;
    summary: string;
    qualification: Record<string, unknown>;
  }) {
    const rows = await db
      .update(conversations)
      .set({ summary: params.summary, qualification: params.qualification })
      .where(
        and(
          eq(conversations.organizationId, params.organizationId),
          eq(conversations.callId, params.callId),
          isNull(conversations.summary),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
};
