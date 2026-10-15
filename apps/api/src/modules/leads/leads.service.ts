import { z } from "zod";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { siteVisitsRepository } from "../../db/repositories/site-visits.repository.js";
import { followUpsRepository } from "../../db/repositories/follow-ups.repository.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { membershipsRepository } from "../../db/repositories/memberships.repository.js";
import { leadStatusEnum } from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { normalizeIndianMobile } from "../../shared/phone.js";
import { parseInput } from "../../shared/validation.js";
import { assertCan, leadScopeFor, projectScopeFor } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { auditService } from "../audit/audit.service.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

type LeadStatus = Parameters<typeof leadsRepository.updateStatus>[0]["status"];

const budget = z.number().int().min(0).max(2_000_000_000);
const nameField = z.string().trim().min(1).max(255);
const phoneField = z.string().min(1).max(32);
const requirementField = z.string().trim().max(100);

const createSchema = z.object({
  name: nameField,
  phone: phoneField,
  projectId: z.string().uuid(),
  requirementConfig: requirementField.optional(),
  budgetMin: budget.optional(),
  budgetMax: budget.optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});
const updateSchema = z.object({
  leadId: z.string().uuid(),
  name: nameField.optional(),
  phone: phoneField.optional(),
  projectId: z.string().uuid().optional(),
  requirementConfig: requirementField.optional(),
  budgetMin: budget.optional(),
  budgetMax: budget.optional(),
  status: z.enum(leadStatusEnum.enumValues).optional(),
});
const assignSchema = z.object({ leadId: z.string().uuid(), userId: z.string().uuid().nullable() });

export type CreateLeadInput = z.input<typeof createSchema>;
export type UpdateLeadDetailsInput = z.input<typeof updateSchema>;
export type LeadFilters = { status?: LeadStatus; projectId?: string; assignedTo?: string };

/** Last 3 digits only: enough to recognise a lead in the audit trail without storing the number. */
const maskPhone = (phone: string) => `*******${phone.slice(-3)}`;

function checkBudgetRange(min: number | null | undefined, max: number | null | undefined) {
  if (min != null && max != null && min > max) throw new ValidationError("budgetMin must not exceed budgetMax");
}

/** The project must exist in THIS organization, be inside the caller's project scope (else 404) and be active. */
async function requireUsableProject(ctx: RequestContext, projectId: string) {
  const project = await projectsRepository.findById({
    organizationId: ctx.organizationId,
    id: projectId,
    scope: await projectScopeFor(ctx),
  });
  if (!project) throw new NotFoundError(`Project ${projectId} not found`);
  if (project.status === "archived") throw new ConflictError("Project is archived");
  return project;
}

/** Assignees must be active members of THIS organization (a user of another org is just an invalid value). */
async function requireActiveMember(ctx: RequestContext, userId: string) {
  const team = await membershipsRepository.listForOrg({ organizationId: ctx.organizationId });
  if (!team.some((m) => m.userId === userId && m.isActive)) {
    throw new ValidationError("Assignee must be an active member of this organization");
  }
}

/**
 * Service boundary for lead data. Routes and AI tools (update_lead,
 * mark_not_interested) call this service — never the repository
 * directly. Every method takes the request context: it only ever touches the
 * caller's organization, and for MANAGER/AGENT roles only the leads in their
 * scope (an out-of-scope lead behaves exactly like one that does not exist).
 * This is also where the LLM's access to lead data is mediated: see
 * ai-tools/update_lead.ts and mark_not_interested.ts (system context).
 */
const leadsServiceImpl = {
  /** Filters apply after the access scope, so they can only narrow what the caller may see. */
  async listLeads(ctx: RequestContext, filters: LeadFilters = {}) {
    assertCan(ctx, "leads:read");
    return leadsRepository.list({ organizationId: ctx.organizationId, scope: await leadScopeFor(ctx), ...filters });
  },

  async createLead(ctx: RequestContext, input: CreateLeadInput) {
    assertCan(ctx, "leads:create");
    const data = parseInput(createSchema, input);
    const phone = normalizeIndianMobile(data.phone);
    checkBudgetRange(data.budgetMin, data.budgetMax);
    await requireUsableProject(ctx, data.projectId);
    if (data.assignedUserId) await requireActiveMember(ctx, data.assignedUserId);
    const org = ctx.organizationId;
    if (await leadsRepository.findDuplicate({ organizationId: org, projectId: data.projectId, phone })) {
      throw new ConflictError("A lead with this phone number already exists in this project");
    }
    const lead = await leadsRepository.create({ ...data, organizationId: org, phone });
    await auditService.record(ctx, {
      action: "lead.created",
      entityType: "lead",
      entityId: lead.id,
      metadata: { projectId: lead.projectId, phone: maskPhone(phone), assignedUserId: lead.assignedUserId },
    });
    return lead;
  },

  /**
   * Edits lead details. Out-of-scope or missing leads return null (route -> 404).
   * AGENTs may only work their own leads (status, requirement, budget), not
   * re-identify them (name/phone/project).
   */
  async updateLeadDetails(ctx: RequestContext, input: UpdateLeadDetailsInput) {
    assertCan(ctx, "leads:update");
    const data = parseInput(updateSchema, input);
    const org = ctx.organizationId;
    const current = await leadsRepository.findById({ organizationId: org, id: data.leadId, scope: await leadScopeFor(ctx) });
    if (!current) return null;
    if (ctx.actor.type === "user" && ctx.actor.role === "AGENT" && (data.name || data.phone || data.projectId)) {
      throw new ForbiddenError("Your role may not change a lead's name, phone or project");
    }

    const phone = data.phone === undefined ? undefined : normalizeIndianMobile(data.phone);
    checkBudgetRange(data.budgetMin ?? current.budgetMin, data.budgetMax ?? current.budgetMax);
    const projectChanged = data.projectId !== undefined && data.projectId !== current.projectId;
    if (projectChanged) await requireUsableProject(ctx, data.projectId!);
    if (projectChanged || (phone !== undefined && phone !== current.phone)) {
      const dup = await leadsRepository.findDuplicate({
        organizationId: org,
        projectId: data.projectId ?? current.projectId,
        phone: phone ?? current.phone,
        excludeId: current.id,
      });
      if (dup) throw new ConflictError("A lead with this phone number already exists in this project");
    }

    const next = {
      name: data.name,
      phone,
      projectId: data.projectId,
      requirementConfig: data.requirementConfig,
      budgetMin: data.budgetMin,
      budgetMax: data.budgetMax,
      status: data.status,
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (k) => next[k] !== undefined && next[k] !== current[k],
    );
    if (changed.length === 0) return current;

    const updated = await leadsRepository.update({ organizationId: org, id: current.id, ...next });
    if (!updated) return null;
    await auditService.record(ctx, {
      action: "lead.updated",
      entityType: "lead",
      entityId: current.id,
      metadata: {
        changedFields: changed,
        ...(changed.includes("status") ? { statusFrom: current.status, statusTo: updated.status } : {}),
        ...(changed.includes("phone") ? { phone: maskPhone(updated.phone) } : {}),
      },
    });
    return updated;
  },

  /** Assigns (or, with userId null, unassigns) a lead. Out-of-scope leads return null (route -> 404). */
  async assignLead(ctx: RequestContext, input: { leadId: string; userId: string | null }) {
    assertCan(ctx, "leads:assign");
    const data = parseInput(assignSchema, input);
    const org = ctx.organizationId;
    const current = await leadsRepository.findById({ organizationId: org, id: data.leadId, scope: await leadScopeFor(ctx) });
    if (!current) return null;
    if (data.userId) await requireActiveMember(ctx, data.userId);
    const updated = await leadsRepository.assign({ organizationId: org, id: current.id, assignedUserId: data.userId });
    if (!updated) return null;
    await auditService.record(ctx, {
      action: "lead.assigned",
      entityType: "lead",
      entityId: current.id,
      metadata: { from: current.assignedUserId, to: data.userId },
    });
    return updated;
  },

  async getLeadDetail(ctx: RequestContext, params: { leadId: string }) {
    assertCan(ctx, "leads:read");
    const org = ctx.organizationId;
    const lead = await leadsRepository.findById({ organizationId: org, id: params.leadId, scope: await leadScopeFor(ctx) });
    if (!lead) return null;
    const [callHistory, siteVisits, followUps] = await Promise.all([
      callsRepository.listByLead({ organizationId: org, leadId: params.leadId }),
      siteVisitsRepository.listByLead({ organizationId: org, leadId: params.leadId }),
      followUpsRepository.listByLead({ organizationId: org, leadId: params.leadId }),
    ]);
    // Attach the conversation (transcript/summary/qualification) for the
    // most recent call, if any, so the dashboard's lead detail screen can
    // render everything in one request.
    const latestCall = callHistory[0];
    const conversation = latestCall
      ? await conversationsRepository.findByCallId({ organizationId: org, callId: latestCall.id })
      : null;
    return { ...lead, callHistory, siteVisits, followUps, latestConversation: conversation };
  },

  async getLeadOrThrow(ctx: RequestContext, params: { leadId: string }) {
    assertCan(ctx, "leads:read");
    const lead = await leadsRepository.findById({
      organizationId: ctx.organizationId,
      id: params.leadId,
      scope: await leadScopeFor(ctx),
    });
    if (!lead) {
      throw new NotFoundError(`Lead ${params.leadId} not found`);
    }
    return lead;
  },

  /** Out-of-scope or missing leads return null without touching anything. */
  async updateLead(
    ctx: RequestContext,
    params: { leadId: string; requirementConfig?: string; budgetMin?: number; budgetMax?: number; status?: LeadStatus },
  ) {
    assertCan(ctx, "leads:update");
    const visible = await leadsRepository.findById({
      organizationId: ctx.organizationId,
      id: params.leadId,
      scope: await leadScopeFor(ctx),
    });
    if (!visible) return null;
    return leadsRepository.update({
      organizationId: ctx.organizationId,
      id: params.leadId,
      requirementConfig: params.requirementConfig,
      budgetMin: params.budgetMin,
      budgetMax: params.budgetMax,
      status: params.status,
    });
  },

  async markNotInterested(ctx: RequestContext, params: { leadId: string }) {
    return leadsService.updateStatus(ctx, { leadId: params.leadId, status: "NOT_INTERESTED" });
  },

  async updateStatus(ctx: RequestContext, params: { leadId: string; status: LeadStatus }) {
    assertCan(ctx, "leads:update");
    const visible = await leadsRepository.findById({
      organizationId: ctx.organizationId,
      id: params.leadId,
      scope: await leadScopeFor(ctx),
    });
    if (!visible) return null;
    return leadsRepository.updateStatus({
      organizationId: ctx.organizationId,
      id: params.leadId,
      status: params.status,
    });
  },
};

export const leadsService = tenantScoped(leadsServiceImpl);
