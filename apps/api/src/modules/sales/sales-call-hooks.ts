/**
 * The Sales module's part in the call lifecycle. Everything lead/project-specific that used to live inside the
 * core call code is here: validating a lead before dialing, choosing the agent for a lead's project, describing
 * the lead and project to the agent, and updating the lead as the call progresses and ends.
 */
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { assertCan, leadScopeFor } from "../../auth/access.js";
import type { LeadScope } from "../../auth/scope.js";
import { db } from "../../db/client.js";
import { calls, leads } from "../../db/schema.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { organizationModulesRepository } from "../../db/repositories/organization-modules.repository.js";
import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import { isGenericSummary } from "../ai-agent/post-call-summary.js";
import type { CallHooks, CallStatusEvent, CallSubject } from "../calls/call-hooks.js";
import { leadsService } from "../leads/leads.service.js";
import { modulesService } from "../modules/modules.service.js";
import { projectsService } from "../projects/projects.service.js";
import { businessNowDescription } from "../site-visits/site-visits.service.js";

const LEAD_STATUS_FOR_EVENT: Record<CallStatusEvent, "ANSWERED" | "BUSY" | "NO_ANSWER" | "RETRY"> = {
  answered: "ANSWERED",
  busy: "BUSY",
  no_answer: "NO_ANSWER",
  failed: "RETRY",
};

/** True when the call's lead (same organization) satisfies `lead`. A call without a lead never matches. */
function callLeadMatches(lead: SQL): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(leads)
      .where(and(eq(leads.organizationId, calls.organizationId), eq(leads.id, calls.leadId), lead)),
  );
}

/**
 * Lead-based call visibility (the Sales rule, unchanged): managers see calls on leads in their projects plus calls
 * with no lead; agents see calls on their assigned leads plus calls they started themselves.
 */
export function salesCallVisibility(scope: LeadScope): SQL | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "projects") {
    return scope.projectIds.length > 0
      ? (or(callLeadMatches(inArray(leads.projectId, scope.projectIds)), isNull(calls.leadId)) as SQL)
      : isNull(calls.leadId);
  }
  return or(callLeadMatches(eq(leads.assignedUserId, scope.userId)), eq(calls.initiatedByUserId, scope.userId)) as SQL;
}

type LeadStatus = Parameters<typeof leadsRepository.updateStatus>[0]["status"];

const lakhs = (rupees: number) => `${Number((rupees / 100_000).toFixed(2))} lakhs`;

/** The budget the CRM holds, in words the agent can use ("60 lakhs to 80 lakhs"); null when there is none. */
export function describeBudget(min: number | null, max: number | null): string | null {
  if (min != null && max != null) return min === max ? lakhs(min) : `${lakhs(min)} to ${lakhs(max)}`;
  if (max != null) return `up to ${lakhs(max)}`;
  if (min != null) return `from ${lakhs(min)}`;
  return null;
}

export const salesCallHooks: CallHooks = {
  name: "sales",

  async pickAgentForLead(ctx, { leadId }) {
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: leadId });
    if (!lead) return null;
    // Legacy rule: the agent bound to the lead's project, else (handled by the core) the organization default.
    const bound = await agentsRepository.findBoundToProject({ organizationId: ctx.organizationId, projectId: lead.projectId });
    return bound?.id ?? null;
  },

  async assertLeadCallable(ctx, leadId) {
    await modulesService.assertEnabled(ctx, "sales");
    assertCan(ctx, "leads:call");
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: leadId, scope: await leadScopeFor(ctx) });
    if (!lead) throw new NotFoundError(`Lead ${leadId} not found`);
    return { name: lead.name, phone: lead.phone };
  },

  async resolveSubject(ctx, call, agent): Promise<CallSubject | null> {
    if (call.leadId) {
      const lead = await leadsService.getLeadOrThrow(ctx, { leadId: call.leadId });
      // The lead's OWN project, never "the default project", so a tenant's call can never get another tenant's knowledge.
      const project = await projectsService.getProjectWithKnowledge(ctx, { projectId: lead.projectId });
      if (!project) throw new Error(`Project ${lead.projectId} not found for lead ${lead.id}`);
      return {
        context: { leadId: lead.id, projectId: project.id },
        provides: ["lead", "project"],
        contactName: lead.name,
        promptParams: {
          leadName: lead.name,
          projectName: project.name,
          contactName: lead.name,
          leadRequirement: lead.requirementConfig,
          leadBudget: describeBudget(lead.budgetMin, lead.budgetMax),
          currentTime: businessNowDescription(),
        },
      };
    }
    // No lead: if the Sales module is on and the agent is bound to a project, that project is the agent's knowledge.
    if (!(await organizationModulesRepository.isEnabled({ organizationId: ctx.organizationId, moduleKey: "sales" }))) return null;
    const bindings = await agentsRepository.listBindings({ organizationId: ctx.organizationId, agentIds: [agent.id] });
    const projectBinding = bindings.find((b) => b.sourceType === "project");
    if (!projectBinding) return null;
    const project = await projectsService.getProjectWithKnowledge(ctx, { projectId: projectBinding.sourceId });
    if (!project) return null;
    return { context: { projectId: project.id }, provides: ["project"], promptParams: { projectName: project.name, currentTime: businessNowDescription() } };
  },

  async onStatus(ctx, call, event) {
    if (!call.leadId) return;
    // Only moves leads that are still mid-dial, so call progress never overwrites real lead outcomes.
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: call.leadId });
    if (lead?.status === "CALLING") {
      await leadsRepository.updateStatus({ organizationId: ctx.organizationId, id: call.leadId, status: LEAD_STATUS_FOR_EVENT[event] });
    }
  },

  async onFinalized(ctx, call, summary) {
    if (!call.leadId || isGenericSummary(summary)) return;
    let status = (summary as { recommendedLeadStatus?: LeadStatus }).recommendedLeadStatus;
    if (!status) return;
    // A lead who asked not to be called stays DNC, whatever the summary suggests.
    const current = await leadsRepository.findById({ organizationId: ctx.organizationId, id: call.leadId });
    if (current?.status === "DNC") return;
    if (status === "VISIT_BOOKED") {
      // The summary is the model's opinion; VISIT_BOOKED is a fact only a booked visit of THIS lead, in the lead's own
      // project, can establish. A visit that was merely offered (or refused) leaves the lead INTERESTED. A booking
      // made on an earlier call still counts.
      const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: call.leadId });
      const visits = await siteVisitsRepository.listByLead({ organizationId: ctx.organizationId, leadId: call.leadId });
      if (!lead || !visits.some((v) => v.status === "booked" && v.projectId === lead.projectId)) status = "INTERESTED";
    }
    await leadsRepository.updateStatus({ organizationId: ctx.organizationId, id: call.leadId, status });
  },

  async callVisibility(ctx) {
    const condition = salesCallVisibility(await leadScopeFor(ctx));
    return condition ? { kind: "where", condition } : { kind: "all" };
  },

  /** Shows the lead's name and phone on listed calls (null for a call without a lead), as the calls list always has. */
  async enrichListedCalls(ctx, listed) {
    const ids = [...new Set(listed.map((c) => c.leadId).filter((id): id is string => !!id))];
    const contacts = new Map((await leadsRepository.findContactsByIds({ organizationId: ctx.organizationId, ids })).map((l) => [l.id, l]));
    return new Map(
      listed.map((c) => {
        const lead = c.leadId ? contacts.get(c.leadId) : undefined;
        return [c.id, { leadName: lead?.name ?? null, leadPhone: lead?.phone ?? null }] as const;
      }),
    );
  },

  async findLeadByPhone(ctx, phone) {
    if (!(await organizationModulesRepository.isEnabled({ organizationId: ctx.organizationId, moduleKey: "sales" }))) return null;
    const ids = await leadsRepository.findIdsByPhone({ organizationId: ctx.organizationId, phone });
    return ids.length === 1 ? ids[0] : null;
  },
};
