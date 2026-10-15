/**
 * Test-only: the repositories as a verification oracle. A call with `organizationId` in its params runs scoped to that
 * organization (as the tenant itself would see it), exactly like a production service would after authenticating.
 * Production code is NEVER given this wrapper: a production call outside a tenant scope still fails closed, which is
 * what these tests rely on to find missing scoping.
 */
import { runInTenant } from "../db/tenant-context.js";

import { agentConfigsRepository as real_agentConfigsRepository } from "../db/repositories/agent-configs.repository.js";
import { agentPhoneNumbersRepository as real_agentPhoneNumbersRepository } from "../db/repositories/agent-phone-numbers.repository.js";
import { agentsRepository as real_agentsRepository } from "../db/repositories/agents.repository.js";
import { auditRepository as real_auditRepository } from "../db/repositories/audit.repository.js";
import { callsRepository as real_callsRepository } from "../db/repositories/calls.repository.js";
import { conversationsRepository as real_conversationsRepository } from "../db/repositories/conversations.repository.js";
import { followUpsRepository as real_followUpsRepository } from "../db/repositories/follow-ups.repository.js";
import { invitationsRepository as real_invitationsRepository } from "../db/repositories/invitations.repository.js";
import { leadsRepository as real_leadsRepository } from "../db/repositories/leads.repository.js";
import { membershipsRepository as real_membershipsRepository } from "../db/repositories/memberships.repository.js";
import { organizationModulesRepository as real_organizationModulesRepository } from "../db/repositories/organization-modules.repository.js";
import { organizationsRepository as real_organizationsRepository } from "../db/repositories/organizations.repository.js";
import { projectMembersRepository as real_projectMembersRepository } from "../db/repositories/project-members.repository.js";
import { projectsRepository as real_projectsRepository } from "../db/repositories/projects.repository.js";
import { sessionsRepository as real_sessionsRepository } from "../db/repositories/sessions.repository.js";
import { siteVisitsRepository as real_siteVisitsRepository } from "../db/repositories/site-visits.repository.js";
import { usageRepository as real_usageRepository } from "../db/repositories/usage.repository.js";
import { usersRepository as real_usersRepository } from "../db/repositories/users.repository.js";

function asTenant<T extends object>(repo: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(repo)) {
    if (typeof member !== "function") {
      wrapped[key] = member;
      continue;
    }
    wrapped[key] = (...args: unknown[]) => {
      const first = args[0] as { organizationId?: unknown } | undefined;
      const org = first && typeof first === "object" ? first.organizationId : undefined;
      const call = () => (member as (...a: unknown[]) => unknown).apply(repo, args);
      return typeof org === "string" ? runInTenant({ organizationId: org }, async () => await call()) : call();
    };
  }
  return wrapped as T;
}

export const agentConfigsRepository = asTenant(real_agentConfigsRepository);
export const agentPhoneNumbersRepository = asTenant(real_agentPhoneNumbersRepository);
export const agentsRepository = asTenant(real_agentsRepository);
export const auditRepository = asTenant(real_auditRepository);
export const callsRepository = asTenant(real_callsRepository);
export const conversationsRepository = asTenant(real_conversationsRepository);
export const followUpsRepository = asTenant(real_followUpsRepository);
export const invitationsRepository = asTenant(real_invitationsRepository);
export const leadsRepository = asTenant(real_leadsRepository);
export const membershipsRepository = asTenant(real_membershipsRepository);
export const organizationModulesRepository = asTenant(real_organizationModulesRepository);
export const organizationsRepository = asTenant(real_organizationsRepository);
export const projectMembersRepository = asTenant(real_projectMembersRepository);
export const projectsRepository = asTenant(real_projectsRepository);
export const sessionsRepository = asTenant(real_sessionsRepository);
export const siteVisitsRepository = asTenant(real_siteVisitsRepository);
export const usageRepository = asTenant(real_usageRepository);
export const usersRepository = asTenant(real_usersRepository);
