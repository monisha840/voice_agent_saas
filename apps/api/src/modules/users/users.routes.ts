import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { routeRateLimit } from "../../security/rate-limits.js";
import { parseInput } from "../../shared/validation.js";
import { usersService } from "./users.service.js";

const role = z.enum(["OWNER", "ADMIN", "MANAGER", "AGENT"]);
const userIdParams = z.object({ userId: z.uuid() });
const invitationIdParams = z.object({ id: z.uuid() });
const inviteBody = z.object({ email: z.email().max(320), role });
const roleBody = z.object({ role });

export async function usersRoutes(app: FastifyInstance) {
  app.get("/api/users", async (req, reply) => {
    return reply.send({ data: await usersService.listTeam(requireContext(req)) });
  });

  app.post("/api/users/invitations", async (req, reply) => {
    const body = parseInput(inviteBody, req.body);
    const data = await usersService.invite(requireContext(req), body);
    return reply.status(201).send({ data });
  });

  app.get("/api/users/invitations", async (req, reply) => {
    return reply.send({ data: await usersService.listInvitations(requireContext(req)) });
  });

  /**
   * Recovery path for a failed or lost invitation email. Rate limited per organization because, unlike the other
   * routes here, an authenticated admin can use it to make the server send mail to an address repeatedly.
   */
  app.post<{ Params: { id: string } }>(
    "/api/users/invitations/:id/resend",
    {
      preHandler: routeRateLimit({
        name: "invite-resend",
        max: 30,
        windowMs: 60 * 60_000,
        key: (req) => req.ctx?.organizationId ?? req.ip,
      }),
    },
    async (req, reply) => {
      const { id } = parseInput(invitationIdParams, req.params);
      const data = await usersService.resendInvitation(requireContext(req), { invitationId: id });
      return reply.status(201).send({ data });
    },
  );

  app.delete<{ Params: { id: string } }>("/api/users/invitations/:id", async (req, reply) => {
    const { id } = parseInput(invitationIdParams, req.params);
    await usersService.revokeInvitation(requireContext(req), { invitationId: id });
    return reply.send({ data: { ok: true } });
  });

  app.patch<{ Params: { userId: string } }>("/api/users/:userId/role", async (req, reply) => {
    const { userId } = parseInput(userIdParams, req.params);
    const body = parseInput(roleBody, req.body);
    const data = await usersService.changeRole(requireContext(req), { userId, role: body.role });
    return reply.send({ data });
  });

  app.delete<{ Params: { userId: string } }>("/api/users/:userId", async (req, reply) => {
    const { userId } = parseInput(userIdParams, req.params);
    await usersService.removeMember(requireContext(req), { userId });
    return reply.send({ data: { ok: true } });
  });
}
