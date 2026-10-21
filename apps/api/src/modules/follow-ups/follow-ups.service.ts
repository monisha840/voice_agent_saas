import { z } from "zod";
import { followUpsRepository, FOLLOW_UP_KINDS } from "../../db/repositories/follow-ups.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { assertCan, leadScopeFor } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { NotFoundError } from "../../shared/errors.js";
import { parseInput } from "../../shared/validation.js";
import { auditService } from "../audit/audit.service.js";
import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { projectScopeFor } from "../../auth/access.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

const MAX_NOTE = 500;

const recordSchema = z.object({
  leadId: z.string().uuid().nullable(),
  callId: z.string().uuid().nullable(),
  kind: z.enum(FOLLOW_UP_KINDS),
  note: z.string().trim().max(MAX_NOTE).nullable().optional(),
  dueAt: z.date().nullable().optional(),
});

export type RecordFollowUpInput = z.input<typeof recordSchema>;

/**
 * What the team must do after a call, as the agent noted it. Written during the call (by the request_follow_up tool,
 * with a system context confined to the call's organization) and worked through by people from the dashboard.
 */
const followUpsServiceImpl = {
  /**
   * Records a follow-up. The same kind recorded twice by one call is one follow-up (the model may ask twice): the later
   * note and time replace the earlier. A do_not_call request also marks the lead DNC.
   */
  async record(ctx: RequestContext, input: RecordFollowUpInput) {
    const data = parseInput(recordSchema, input);
    const org = ctx.organizationId;
    if (data.leadId) {
      const lead = await leadsRepository.findById({ organizationId: org, id: data.leadId });
      if (!lead) throw new NotFoundError(`Lead ${data.leadId} not found`);
    }
    const note = data.note?.trim() ? data.note.trim() : null;
    const dueAt = data.dueAt ?? null;
    const existing = data.callId ? await followUpsRepository.findOpenForCall({ organizationId: org, callId: data.callId, kind: data.kind }) : null;
    let row;
    if (existing) {
      // Several things the agent could not answer on one call are all kept; for the other kinds the latest note wins.
      const merged =
        data.kind === "info_requested" && note && existing.note && !existing.note.includes(note) ? `${existing.note}; ${note}`.slice(0, MAX_NOTE) : (note ?? existing.note);
      row = (await followUpsRepository.update({ organizationId: org, id: existing.id, note: merged, dueAt: dueAt ?? existing.dueAt })) ?? existing;
    } else {
      row = await followUpsRepository.create({ organizationId: org, leadId: data.leadId, callId: data.callId, kind: data.kind, note, dueAt });
      await auditService.record(ctx, {
        action: "follow_up.created",
        entityType: "follow_up",
        entityId: row.id,
        metadata: { kind: data.kind, leadId: data.leadId, callId: data.callId, dueAt: dueAt?.toISOString() ?? null },
      });
    }
    if (data.kind === "do_not_call" && data.leadId) {
      await leadsRepository.updateStatus({ organizationId: org, id: data.leadId, status: "DNC" });
    }
    return row;
  },

  /** The follow-ups of one lead the caller may see. A lead outside the caller's scope is "not found". */
  async listForLead(ctx: RequestContext, params: { leadId: string }) {
    assertCan(ctx, "leads:read");
    const lead = await leadsRepository.findById({ organizationId: ctx.organizationId, id: params.leadId, scope: await leadScopeFor(ctx) });
    if (!lead) throw new NotFoundError(`Lead ${params.leadId} not found`);
    return followUpsRepository.listByLead({ organizationId: ctx.organizationId, leadId: params.leadId });
  },

  /** Questions callers asked about a project that the agent could not answer (the project must be visible to the caller). */
  async unansweredForProject(ctx: RequestContext, params: { projectId: string }) {
    assertCan(ctx, "projects:read");
    const project = await projectsRepository.findById({ organizationId: ctx.organizationId, id: params.projectId, scope: await projectScopeFor(ctx) });
    if (!project) throw new NotFoundError(`Project ${params.projectId} not found`);
    return followUpsRepository.listInfoRequestsForProject({ organizationId: ctx.organizationId, projectId: params.projectId });
  },

  async listOpen(ctx: RequestContext) {
    assertCan(ctx, "leads:read");
    return followUpsRepository.listOpen({ organizationId: ctx.organizationId, scope: await leadScopeFor(ctx) });
  },

  /** Marks a follow-up done. Out of scope or missing -> null (route -> 404). */
  async resolve(ctx: RequestContext, params: { id: string }) {
    assertCan(ctx, "leads:update");
    const org = ctx.organizationId;
    const current = await followUpsRepository.findById({ organizationId: org, id: params.id });
    if (!current) return null;
    const scope = await leadScopeFor(ctx);
    if (current.leadId) {
      const lead = await leadsRepository.findById({ organizationId: org, id: current.leadId, scope });
      if (!lead) return null;
    } else if (scope.kind !== "all") {
      return null;
    }
    if (current.status === "done") return current;
    const done = await followUpsRepository.markDone({ organizationId: org, id: current.id });
    if (done) {
      await auditService.record(ctx, { action: "follow_up.done", entityType: "follow_up", entityId: current.id, metadata: { kind: current.kind, leadId: current.leadId } });
    }
    return done;
  },
};

export const followUpsService = tenantScoped(followUpsServiceImpl);
