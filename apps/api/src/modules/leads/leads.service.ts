import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Service boundary for lead data. Routes and AI tools (update_lead,
 * mark_not_interested) call this service — never the repository
 * directly. This is also where the LLM's access to lead data is
 * mediated: see ai-tools/update_lead.ts and mark_not_interested.ts.
 */
export const leadsService = {
  async listLeads() {
    return leadsRepository.list();
  },

  async getLeadDetail(params: { leadId: string }) {
    const lead = await leadsRepository.findById({ id: params.leadId });
    if (!lead) return null;

    const [callHistory, siteVisits] = await Promise.all([
      callsRepository.listByLead({ leadId: params.leadId }),
      siteVisitsRepository.listByLead({ leadId: params.leadId }),
    ]);

    // Attach the conversation (transcript/summary/qualification) for the
    // most recent call, if any, so the dashboard's lead detail screen can
    // render everything in one request.
    const latestCall = callHistory[0];
    const conversation = latestCall
      ? await conversationsRepository.findByCallId({ callId: latestCall.id })
      : null;

    return { ...lead, callHistory, siteVisits, latestConversation: conversation };
  },

  async getLeadOrThrow(params: { leadId: string }) {
    const lead = await leadsRepository.findById({ id: params.leadId });
    if (!lead) {
      throw new NotFoundError(`Lead ${params.leadId} not found`);
    }
    return lead;
  },

  async updateLead(params: {
    leadId: string;
    requirementConfig?: string;
    budgetMin?: number;
    budgetMax?: number;
    status?: Parameters<typeof leadsRepository.update>[0]["status"];
  }) {
    return leadsRepository.update({
      id: params.leadId,
      requirementConfig: params.requirementConfig,
      budgetMin: params.budgetMin,
      budgetMax: params.budgetMax,
      status: params.status,
    });
  },

  async markNotInterested(params: { leadId: string }) {
    return leadsRepository.updateStatus({ id: params.leadId, status: "NOT_INTERESTED" });
  },

  async updateStatus(params: {
    leadId: string;
    status: Parameters<typeof leadsRepository.updateStatus>[0]["status"];
  }) {
    return leadsRepository.updateStatus({ id: params.leadId, status: params.status });
  },
};
