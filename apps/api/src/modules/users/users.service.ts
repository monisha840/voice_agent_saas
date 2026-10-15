import { isUniqueViolation } from "../../db/pg-error.js";
import { securityEvents } from "../../security/security-events.js";
import { checkPassword, PASSWORD_PROBLEM_MESSAGE } from "../../auth/password-policy.js";
import { createHash, randomBytes } from "node:crypto";
import { assertCan } from "../../auth/access.js";
import { userContext, type OrgRole, type RequestContext } from "../../auth/context.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { canGrantRole, canManageMemberWithRole } from "../../auth/permissions.js";
import { invitationsRepository } from "../../db/repositories/invitations.repository.js";
import { membershipsRepository } from "../../db/repositories/memberships.repository.js";
import { usersRepository } from "../../db/repositories/users.repository.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const INVALID_INVITATION = "Invalid or expired invitation";

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** System actors are trusted internal flows; for hierarchy checks they count as OWNER. */
function actorRole(ctx: RequestContext): OrgRole {
  return ctx.actor.type === "user" ? ctx.actor.role : "OWNER";
}

function actorUserId(ctx: RequestContext): string | null {
  return ctx.actor.type === "user" ? ctx.actor.userId : null;
}

/** Shared by role change and removal: the target must be a member of THIS organization and manageable by the actor. */
async function loadManageableMember(ctx: RequestContext, userId: string) {
  const member = await membershipsRepository.findByUserAndOrg({ userId, organizationId: ctx.organizationId });
  if (!member) throw new NotFoundError("User not found");
  if (actorUserId(ctx) === userId) throw new ForbiddenError("You cannot change your own membership");
  if (!canManageMemberWithRole(actorRole(ctx), member.role)) {
    throw new ForbiddenError("Your role cannot manage a member with this role");
  }
  return member;
}

async function assertNotLastOwner(ctx: RequestContext, current: OrgRole) {
  if (current !== "OWNER") return;
  if ((await membershipsRepository.countOwners({ organizationId: ctx.organizationId })) <= 1) {
    throw new ConflictError("An organization must keep at least one owner");
  }
}

const usersServiceImpl = {
  async listTeam(ctx: RequestContext) {
    assertCan(ctx, "users:read");
    return membershipsRepository.listForOrg({ organizationId: ctx.organizationId });
  },

  async invite(ctx: RequestContext, input: { email: string; role: OrgRole }) {
    assertCan(ctx, "users:invite");
    if (!canGrantRole(actorRole(ctx), input.role)) {
      throw new ForbiddenError("Your role cannot invite someone with this role");
    }
    const email = input.email.trim().toLowerCase();
    const existing = await usersRepository.findByEmail({ email });
    if (existing && (await membershipsRepository.findByUserAndOrg({ userId: existing.id, organizationId: ctx.organizationId }))) {
      throw new ConflictError("This person is already a member of the organization");
    }
    await invitationsRepository.revokePendingForEmail({ organizationId: ctx.organizationId, email });
    const token = randomBytes(32).toString("base64url");
    const invitation = await invitationsRepository.create({
      organizationId: ctx.organizationId,
      email,
      role: input.role,
      tokenHash: hashInviteToken(token),
      invitedByUserId: actorUserId(ctx),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    await auditService.record(ctx, {
      action: "user.invited",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { email, role: input.role },
    });
    return {
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
      inviteToken: token,
      acceptPath: `/accept-invite?token=${token}`,
    };
  },

  async listInvitations(ctx: RequestContext) {
    assertCan(ctx, "users:manage");
    const rows = await invitationsRepository.listPending({ organizationId: ctx.organizationId, now: new Date() });
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      invitedByUserId: i.invitedByUserId,
    }));
  },

  async revokeInvitation(ctx: RequestContext, params: { invitationId: string }) {
    assertCan(ctx, "users:manage");
    const invitation = await invitationsRepository.findById({ organizationId: ctx.organizationId, id: params.invitationId });
    if (!invitation || invitation.acceptedAt) throw new NotFoundError("Invitation not found");
    await invitationsRepository.revoke({ organizationId: ctx.organizationId, id: invitation.id });
    await auditService.record(ctx, {
      action: "user.invitation_revoked",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
    });
  },

  async changeRole(ctx: RequestContext, params: { userId: string; role: OrgRole }) {
    assertCan(ctx, "users:manage");
    const member = await loadManageableMember(ctx, params.userId);
    if (!canGrantRole(actorRole(ctx), params.role)) {
      throw new ForbiddenError("Your role cannot grant this role");
    }
    if (member.role === params.role) return { userId: params.userId, role: member.role };
    if (params.role !== "OWNER") await assertNotLastOwner(ctx, member.role);
    // The role change and the end of that user's sessions in this organization are one transaction.
    const revoked = await membershipsRepository.updateRoleRevokingSessions({
      organizationId: ctx.organizationId,
      userId: params.userId,
      role: params.role,
    });
    await securityEvents.record({
      type: "membership.role_changed",
      outcome: "success",
      userId: params.userId,
      organizationId: ctx.organizationId,
      metadata: { from: member.role, to: params.role, by: actorUserId(ctx), sessionsRevoked: revoked },
    });
    await auditService.record(ctx, {
      action: "user.role_changed",
      entityType: "user",
      entityId: params.userId,
      metadata: { from: member.role, to: params.role },
    });
    return { userId: params.userId, role: params.role };
  },

  async removeMember(ctx: RequestContext, params: { userId: string }) {
    assertCan(ctx, "users:manage");
    const member = await loadManageableMember(ctx, params.userId);
    await assertNotLastOwner(ctx, member.role);
    await membershipsRepository.removeWithCleanup({ organizationId: ctx.organizationId, userId: params.userId });
    await securityEvents.record({
      type: "membership.removed",
      outcome: "success",
      userId: params.userId,
      organizationId: ctx.organizationId,
      metadata: { role: member.role, by: actorUserId(ctx) },
    });
    await auditService.record(ctx, {
      action: "user.removed",
      entityType: "user",
      entityId: params.userId,
      metadata: { role: member.role },
    });
  },

  /**
   * PUBLIC (the invite token is the credential). Every unusable-token case
   * returns the same error so a caller cannot probe which tokens exist.
   */
  async acceptInvite(input: { token: string; name: string; password: string }) {
    const invitation = await invitationsRepository.findUsableByTokenHashAnyOrg({
      tokenHash: hashInviteToken(input.token),
      now: new Date(),
    });
    if (!invitation) throw new ValidationError(INVALID_INVITATION);

    const existing = await usersRepository.findByEmail({ email: invitation.email });
    if (!existing) {
      const problem = await checkPassword({ password: input.password, email: invitation.email, name: input.name });
      if (problem) throw new ValidationError(PASSWORD_PROBLEM_MESSAGE[problem]);
    }
    if (existing) {
      // An existing account joins another organization: prove it is theirs; never change its password.
      if (!existing.isActive || !(await verifyPassword(input.password, existing.passwordHash))) {
        throw new UnauthorizedError("Invalid email or password");
      }
      if (await membershipsRepository.findByUserAndOrg({ userId: existing.id, organizationId: invitation.organizationId })) {
        throw new ValidationError(INVALID_INVITATION);
      }
    }

    const accepted = await invitationsRepository.accept({
      invitation,
      existingUserId: existing?.id,
      newUser: existing
        ? undefined
        : { email: invitation.email, name: input.name, passwordHash: await hashPassword(input.password) },
      now: new Date(),
    }).catch((err: unknown) => {
      // A concurrent sign-up for the same email lost the race on users_email_unique.
      if (isUniqueViolation(err)) return null;
      throw err;
    });
    if (!accepted) throw new ValidationError(INVALID_INVITATION);

    await auditService.record(userContext(invitation.organizationId, accepted.userId, invitation.role), {
      action: "user.invite_accepted",
      entityType: "invitation",
      entityId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
    });
    const user = (await usersRepository.findById({ id: accepted.userId }))!;
    return { user, organizationId: invitation.organizationId };
  },
};

export const usersService = tenantScoped(usersServiceImpl);
