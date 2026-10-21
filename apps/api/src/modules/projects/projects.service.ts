import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { projectMembersRepository } from "../../db/repositories/project-members.repository.js";
import { membershipsRepository } from "../../db/repositories/memberships.repository.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { parseInput } from "../../shared/validation.js";
import { assertCan, projectScopeFor } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { auditService } from "../audit/audit.service.js";
import { isKnowledgeCategory, knowledgeSchemas } from "./knowledge.schemas.js";
import { importFaqCsv, importUnitsCsv, type ImportKind } from "./knowledge-import.js";
import { buildDraftMessages, parseKnowledgeDraft, type KnowledgeDraft } from "./knowledge-draft.js";
import { getLlmProvider } from "../../adapters/ai/index.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

/**
 * Service boundary for project data. Routes and AI tools (get_project_*)
 * call this service — never the repository or raw SQL directly. Every method
 * takes the request context: it only ever sees the caller's organization, and
 * for MANAGER/AGENT roles only the projects they are scoped to.
 * All project facts the AI may quote come from project_knowledge rows
 * fetched here, never hardcoded in this service or in any AI adapter.
 */
const projectsServiceImpl = {
  async getProjectWithKnowledge(ctx: RequestContext, params: { projectId: string }) {
    assertCan(ctx, "projects:read");
    const scope = await projectScopeFor(ctx);
    const project = await projectsRepository.findById({ organizationId: ctx.organizationId, id: params.projectId, scope });
    if (!project) return null;
    const knowledge = await projectsRepository.getKnowledge({
      organizationId: ctx.organizationId,
      projectId: params.projectId,
    });
    return { ...project, knowledge };
  },

  /** Archived projects stay readable by id but are hidden from the list unless asked for. */
  async listProjects(ctx: RequestContext, options: { includeArchived?: boolean } = {}) {
    assertCan(ctx, "projects:read");
    return projectsRepository.list({
      organizationId: ctx.organizationId,
      scope: await projectScopeFor(ctx),
      includeArchived: options.includeArchived,
    });
  },

  /** The organization's oldest active project (the demo organization has exactly one). */
  async getDefaultProject(ctx: RequestContext) {
    assertCan(ctx, "projects:read");
    const scope = await projectScopeFor(ctx);
    let [project] = await projectsRepository.list({ organizationId: ctx.organizationId, scope });
    if (!project) {
      [project] = await projectsRepository.list({ organizationId: ctx.organizationId, scope, includeArchived: true });
    }
    if (!project) {
      throw new NotFoundError("No project found for this organization.");
    }
    return project;
  },

  async getKnowledgeByCategory(ctx: RequestContext, params: { projectId: string; category: string }) {
    assertCan(ctx, "projects:read");
    const scope = await projectScopeFor(ctx);
    const project = await projectsRepository.findById({ organizationId: ctx.organizationId, id: params.projectId, scope });
    if (!project) return [];
    const knowledge = await projectsRepository.getKnowledge({
      organizationId: ctx.organizationId,
      projectId: params.projectId,
    });
    return knowledge.filter((k) => k.category === params.category);
  },

  async createProject(ctx: RequestContext, params: { name: string; location: string; description?: string }) {
    assertCan(ctx, "projects:create");
    const name = params.name.trim();
    await assertNameFree(ctx, name);
    const project = await projectsRepository.create({
      organizationId: ctx.organizationId,
      name,
      location: params.location.trim(),
      description: params.description?.trim() || undefined,
    });
    await auditService.record(ctx, { action: "project.created", entityType: "project", entityId: project.id, metadata: { name: project.name } });
    return project;
  },

  /** Returns null when the project does not exist or is outside the caller's scope. */
  async updateProject(
    ctx: RequestContext,
    params: { projectId: string; name?: string; location?: string; description?: string | null },
  ) {
    assertCan(ctx, "projects:update");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;

    const patch: { name?: string; location?: string; description?: string | null } = {};
    if (params.name !== undefined) patch.name = params.name.trim();
    if (params.location !== undefined) patch.location = params.location.trim();
    if (params.description !== undefined) patch.description = params.description?.trim() || null;
    if (patch.name !== undefined && patch.name !== existing.name && existing.status !== "archived") {
      await assertNameFree(ctx, patch.name, existing.id);
    }

    const project = await projectsRepository.update({ organizationId: ctx.organizationId, id: existing.id, patch });
    if (!project) return null;
    await auditService.record(ctx, {
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      metadata: { changed: Object.keys(patch) },
    });
    return project;
  },

  async archiveProject(ctx: RequestContext, params: { projectId: string }) {
    assertCan(ctx, "projects:archive");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;
    const project = await projectsRepository.setArchived({ organizationId: ctx.organizationId, id: existing.id, archived: true });
    await auditService.record(ctx, { action: "project.archived", entityType: "project", entityId: existing.id });
    return project;
  },

  async unarchiveProject(ctx: RequestContext, params: { projectId: string }) {
    assertCan(ctx, "projects:archive");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;
    if (existing.status === "archived") await assertNameFree(ctx, existing.name, existing.id);
    const project = await projectsRepository.setArchived({ organizationId: ctx.organizationId, id: existing.id, archived: false });
    await auditService.record(ctx, { action: "project.unarchived", entityType: "project", entityId: existing.id });
    return project;
  },

  /** Insert-or-replace the single row for (project, category) after validating the content shape. */
  async upsertKnowledge(ctx: RequestContext, params: { projectId: string; category: string; content: unknown }) {
    assertCan(ctx, "projects:update");
    const category = assertCategory(params.category);
    const content = parseInput(knowledgeSchemas[category], params.content);
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;
    const row = await projectsRepository.upsertKnowledge({
      organizationId: ctx.organizationId,
      projectId: existing.id,
      category,
      content,
    });
    await auditService.record(ctx, {
      action: "project.knowledge_updated",
      entityType: "project",
      entityId: existing.id,
      metadata: { category },
    });
    return row;
  },

  /**
   * Proposes structured knowledge from pasted brochure / price-sheet / FAQ text. Writes NOTHING: the proposal is shown to
   * a person, and each approved category is saved through upsertKnowledge like any other edit.
   */
  async draftKnowledge(ctx: RequestContext, params: { projectId: string; text: string }): Promise<(KnowledgeDraft & { projectId: string }) | null> {
    assertCan(ctx, "projects:update");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;
    const result = await getLlmProvider().chat(buildDraftMessages(params.text), []);
    const draft = parseKnowledgeDraft(result.content ?? "");
    await auditService.record(ctx, {
      action: "project.knowledge_drafted",
      entityType: "project",
      entityId: existing.id,
      metadata: { proposed: Object.keys(draft.drafts), rejected: draft.rejected.length },
    });
    return { projectId: existing.id, ...draft };
  },

  /**
   * Imports a client's spreadsheet (CSV) as project knowledge. `units` replaces the project's units and price ranges;
   * `faq` replaces its questions. With `dryRun` nothing is written and the result shows what would be.
   */
  async importKnowledge(ctx: RequestContext, params: { projectId: string; kind: ImportKind; csv: string; dryRun?: boolean }) {
    assertCan(ctx, "projects:update");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;

    const parsed = params.kind === "units" ? importUnitsCsv(params.csv) : importFaqCsv(params.csv);
    const wrote: string[] = [];
    if (parsed.accepted === 0) {
      throw new ValidationError(`Nothing could be imported: ${parsed.rejected[0]?.reason ?? "no valid rows"}`);
    }
    if (!params.dryRun) {
      if (parsed.kind === "units") {
        await projectsService.upsertKnowledge(ctx, { projectId: existing.id, category: "configurations", content: { units: parsed.units } });
        wrote.push("configurations");
        if (parsed.ranges.length > 0 || parsed.perSqft) {
          const [current] = await projectsRepository
            .getKnowledge({ organizationId: ctx.organizationId, projectId: existing.id })
            .then((rows) => rows.filter((r) => r.category === "pricing"));
          const previous = (current?.content ?? {}) as { currency?: string; notes?: string };
          await projectsService.upsertKnowledge(ctx, {
            projectId: existing.id,
            category: "pricing",
            content: {
              currency: previous.currency ?? "INR",
              ranges: parsed.ranges,
              ...(parsed.perSqft ? { perSqft: parsed.perSqft } : {}),
              ...(previous.notes ? { notes: previous.notes } : {}),
            },
          });
          wrote.push("pricing");
        }
      } else {
        await projectsService.upsertKnowledge(ctx, { projectId: existing.id, category: "faq", content: { items: parsed.items } });
        wrote.push("faq");
      }
    }
    return {
      kind: parsed.kind,
      dryRun: params.dryRun === true,
      accepted: parsed.accepted,
      rejected: parsed.rejected,
      wrote,
      preview: parsed.kind === "units" ? parsed.units.slice(0, 5) : parsed.items.slice(0, 5),
    };
  },

  /** Returns false when the project is not visible to the caller or has no such row. */
  async deleteKnowledge(ctx: RequestContext, params: { projectId: string; category: string }) {
    assertCan(ctx, "projects:update");
    const category = assertCategory(params.category);
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return false;
    const removed = await projectsRepository.deleteKnowledge({ organizationId: ctx.organizationId, projectId: existing.id, category });
    if (!removed) return false;
    await auditService.record(ctx, {
      action: "project.knowledge_deleted",
      entityType: "project",
      entityId: existing.id,
      metadata: { category },
    });
    return true;
  },

  async getProjectMembers(ctx: RequestContext, params: { projectId: string }) {
    assertCan(ctx, "projects:members");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;
    return projectMembersRepository.listForProject({ organizationId: ctx.organizationId, projectId: existing.id });
  },

  /** Replaces the member list; every user must be an active member of THIS organization. */
  async setProjectMembers(ctx: RequestContext, params: { projectId: string; userIds: string[] }) {
    assertCan(ctx, "projects:members");
    const existing = await findScoped(ctx, params.projectId);
    if (!existing) return null;

    const userIds = [...new Set(params.userIds)];
    const team = await membershipsRepository.listForOrg({ organizationId: ctx.organizationId });
    const activeIds = new Set(team.filter((m) => m.isActive).map((m) => m.userId));
    if (userIds.some((id) => !activeIds.has(id))) {
      throw new ValidationError("userIds must all be active members of this organization");
    }

    await projectMembersRepository.replaceForProject({ organizationId: ctx.organizationId, projectId: existing.id, userIds });
    await auditService.record(ctx, {
      action: "project.members_updated",
      entityType: "project",
      entityId: existing.id,
      metadata: { count: userIds.length },
    });
    return projectMembersRepository.listForProject({ organizationId: ctx.organizationId, projectId: existing.id });
  },
};

async function findScoped(ctx: RequestContext, projectId: string) {
  const scope = await projectScopeFor(ctx);
  return projectsRepository.findById({ organizationId: ctx.organizationId, id: projectId, scope });
}

async function assertNameFree(ctx: RequestContext, name: string, excludeId?: string) {
  const clash = await projectsRepository.findActiveByName({ organizationId: ctx.organizationId, name, excludeId });
  if (clash) throw new ConflictError(`A project named "${name}" already exists.`);
}

function assertCategory(category: string) {
  if (!isKnowledgeCategory(category)) {
    throw new ValidationError(`Unknown knowledge category "${category.slice(0, 50)}"`);
  }
  return category;
}

export const projectsService = tenantScoped(projectsServiceImpl);
