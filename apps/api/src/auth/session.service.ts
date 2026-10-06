/**
 * Login sessions. The browser holds a random opaque token in an httpOnly
 * cookie; the database holds only its SHA-256, so a database leak cannot be
 * turned into valid cookies. Sessions expire after an idle period (sliding)
 * and after an absolute maximum age.
 */
import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config/env.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const REFRESH_AFTER_MS = 10 * 60_000; // avoid a write on every request

export const sessionService = {
  async create(params: { userId: string; activeOrganizationId?: string | null; ipAddress?: string; userAgent?: string }) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + getConfig().auth.sessionTtlMs);
    await sessionsRepository.create({
      userId: params.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      activeOrganizationId: params.activeOrganizationId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
    return { token, expiresAt };
  },

  /** Returns the live session + user for a cookie token, or null (unknown / expired / disabled user). */
  async resolve(token: string) {
    if (!token || token.length > 200) return null;
    const tokenHash = hashSessionToken(token);
    const found = await sessionsRepository.findWithUserByTokenHash({ tokenHash });
    if (!found) return null;
    const { session, user } = found;
    const cfg = getConfig().auth;
    const now = Date.now();
    const tooOld = now - session.createdAt.getTime() > cfg.sessionMaxAgeMs;
    if (session.expiresAt.getTime() <= now || tooOld || !user.isActive) {
      await sessionsRepository.deleteByTokenHash({ tokenHash });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
      const newExpiry = Math.min(now + cfg.sessionTtlMs, session.createdAt.getTime() + cfg.sessionMaxAgeMs);
      await sessionsRepository.touch({ id: session.id, expiresAt: new Date(newExpiry) });
    }
    return { session, user };
  },

  async setActiveOrganization(sessionId: string, organizationId: string) {
    await sessionsRepository.setActiveOrganization({ id: sessionId, organizationId });
  },

  async revoke(token: string) {
    await sessionsRepository.deleteByTokenHash({ tokenHash: hashSessionToken(token) });
  },

  async revokeAllForUser(userId: string) {
    await sessionsRepository.deleteAllForUser({ userId });
  },
};
