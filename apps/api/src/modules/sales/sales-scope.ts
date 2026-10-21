/**
 * Who may see which leads and projects. This is the Sales module's data-level access rule (moved out of the core's
 * auth/access.ts): owners and admins see everything, a manager sees the projects they were added to and every lead in
 * them, an agent sees only the leads assigned to them (and the projects those leads or their membership point to).
 */
import type { ScopeProvider } from "../../auth/access.js";
import type { LeadScope, ProjectScope } from "../../auth/scope.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { projectMembersRepository } from "../../db/repositories/project-members.repository.js";

export const salesScopeProvider: ScopeProvider = {
  async lead(ctx): Promise<LeadScope> {
    if (ctx.actor.type !== "user") return { kind: "all" };
    switch (ctx.actor.role) {
      case "OWNER":
      case "ADMIN":
        return { kind: "all" };
      case "MANAGER":
        return {
          kind: "projects",
          projectIds: await projectMembersRepository.listProjectIdsForUser({
            organizationId: ctx.organizationId,
            userId: ctx.actor.userId,
          }),
        };
      case "AGENT":
        return { kind: "assigned", userId: ctx.actor.userId };
    }
  },

  async project(ctx): Promise<ProjectScope> {
    if (ctx.actor.type !== "user") return { kind: "all" };
    switch (ctx.actor.role) {
      case "OWNER":
      case "ADMIN":
        return { kind: "all" };
      case "MANAGER":
        return {
          kind: "ids",
          projectIds: await projectMembersRepository.listProjectIdsForUser({
            organizationId: ctx.organizationId,
            userId: ctx.actor.userId,
          }),
        };
      case "AGENT": {
        const member = await projectMembersRepository.listProjectIdsForUser({
          organizationId: ctx.organizationId,
          userId: ctx.actor.userId,
        });
        const viaLeads = await leadsRepository.distinctProjectIdsAssignedTo({
          organizationId: ctx.organizationId,
          userId: ctx.actor.userId,
        });
        return { kind: "ids", projectIds: [...new Set([...member, ...viaLeads])] };
      }
    }
  },
};
