import { callsRepository } from "../../db/repositories/calls.repository.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { getLlmProvider } from "../../adapters/ai/index.js";
import { generateCallSummary } from "../ai-agent/post-call-summary.js";
import { logger } from "../../shared/logger.js";
import { NotFoundError } from "../../shared/errors.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";

/**
 * Service boundary for call data and the post-call pipeline. The live
 * call orchestration (telephony + STT/LLM/TTS loop) is driven from the
 * websocket handler, but it calls back into this service to create the
 * call record, start the conversation record, and finalize everything
 * once the call ends.
 */
export const callsService = {
  async getCallDetail(params: { callId: string }) {
    const call = await callsRepository.findById({ id: params.callId });
    if (!call) return null;

    const conversation = await conversationsRepository.findByCallId({ callId: params.callId });
    return { ...call, conversation };
  },

  async createCall(params: { leadId: string }) {
    const call = await callsRepository.create({ leadId: params.leadId, status: "initiating" });
    await conversationsRepository.createForCall({ callId: call.id });
    return call;
  },

  async attachProviderCallId(params: { callId: string; providerCallId: string }) {
    return callsRepository.setProviderCallId({ id: params.callId, providerCallId: params.providerCallId });
  },

  async markFailed(params: { callId: string }) {
    return callsRepository.updateStatus({ id: params.callId, status: "failed", endedAt: new Date() });
  },

  async updateStatusFromProvider(params: {
    providerCallId: string;
    status: "ringing" | "in_progress" | "completed" | "failed";
    durationSeconds?: number;
    recordingUrl?: string;
  }) {
    const call = await callsRepository.findByProviderCallId({ providerCallId: params.providerCallId });
    if (!call) {
      logger.warn("calls.service: status callback for unknown providerCallId", {
        providerCallId: params.providerCallId,
      });
      return null;
    }

    const now = new Date();
    const updated = await callsRepository.updateStatus({
      id: call.id,
      status: params.status,
      startedAt: params.status === "in_progress" && !call.startedAt ? now : undefined,
      endedAt: params.status === "completed" || params.status === "failed" ? now : undefined,
      recordingUrl: params.recordingUrl,
    });

    if (params.status === "completed") {
      await this.finalizeCall({ callId: call.id });
    }

    return updated;
  },

  /**
   * Runs the Phase 6 post-call pipeline: generate structured summary
   * from the persisted transcript, store it, and update lead status.
   * Safe to call multiple times (idempotent on already-summarized calls
   * is not strictly enforced for the MVP, but harmless since it just
   * regenerates the same kind of summary).
   */
  async finalizeCall(params: { callId: string }) {
    const call = await callsRepository.findById({ id: params.callId });
    if (!call) throw new NotFoundError(`Call ${params.callId} not found`);

    const conversation = await conversationsRepository.findByCallId({ callId: params.callId });
    const transcript = (conversation?.transcript as TranscriptTurn[] | null) ?? [];

    const llm = getLlmProvider();
    const qualification = await generateCallSummary(llm, transcript);

    await conversationsRepository.setSummary({
      callId: params.callId,
      summary: qualification.summary,
      qualification: qualification as unknown as Record<string, unknown>,
    });

    await leadsRepository.updateStatus({
      id: call.leadId,
      status: qualification.recommendedLeadStatus,
    });

    logger.info("calls.service: call finalized", {
      callId: params.callId,
      recommendedLeadStatus: qualification.recommendedLeadStatus,
    });

    return qualification;
  },
};
