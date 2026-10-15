/**
 * Login sessions. The browser holds a random opaque token in an httpOnly
 * cookie; the database holds only its SHA-256, so a database leak cannot be
 * turned into valid cookies. Sessions expire after an idle period (sliding)
 * and after an absolute maximum age.
 *
 * A session on an account with MFA starts "pending": it exists, but only the
 * second-factor step can use it, and it lives only briefly, until the second
 * factor is passed (completeMfa).
 */
import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config/env.js";
import { sessionsRepository } from "../db/repositories/sessions.repository.js";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const REFRESH_AFTER_MS = 10 * 60_000; // avoid a write on every request

export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Last octet(s) masked: enough to recognise a location, not to identify an address. */
  ip: string | null;
  device: string;
  mfaVerified: boolean;
}

/** "203.0.113.45" -> "203.0.113.x", "2001:db8:1:2::3" -> "2001:db8:1:x". */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip.includes(".")) return ip.replace(/\.\d+$/, ".x");
  const parts = ip.split(":");
  return parts.length > 3 ? `${parts.slice(0, 3).join(":")}:x` : "x";
}

/** A short human label ("Chrome on Windows") from a User-Agent; never echoes the raw header. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

export const sessionService = {
  async create(params: {
    userId: string;
    activeOrganizationId?: string | null;
    ipAddress?: string;
    userAgent?: string;
    /** The account has MFA and the second factor has not been passed yet. */
    mfaPending?: boolean;
  }) {
    const token = randomBytes(32).toString("base64url");
    const cfg = getConfig().auth;
    const now = Date.now();
    const lifetime = params.mfaPending ? Math.min(cfg.sessionTtlMs, cfg.mfa.pendingTtlMs) : cfg.sessionTtlMs;
    const expiresAt = new Date(now + lifetime);
    const session = await sessionsRepository.create({
      userId: params.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      activeOrganizationId: params.activeOrganizationId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      mfaVerifiedAt: params.mfaPending ? null : new Date(now),
    });
    return { token, expiresAt, sessionId: session.id };
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
    // A session that predates the account's current password can never be resumed (belt and braces: password
    // changes already delete the user's sessions in the same transaction).
    const predatesPassword = !!user.passwordChangedAt && session.createdAt.getTime() < user.passwordChangedAt.getTime();
    if (session.expiresAt.getTime() <= now || tooOld || !user.isActive || predatesPassword) {
      await sessionsRepository.deleteByTokenHash({ tokenHash });
      return null;
    }
    const pending = !!user.mfaEnabledAt && !session.mfaVerifiedAt;
    // A half-finished login is never extended; it simply times out.
    if (!pending && now - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
      const newExpiry = Math.min(now + cfg.sessionTtlMs, session.createdAt.getTime() + cfg.sessionMaxAgeMs);
      await sessionsRepository.touch({ id: session.id, expiresAt: new Date(newExpiry) });
    }
    return { session, user };
  },

  async setActiveOrganization(sessionId: string, organizationId: string) {
    await sessionsRepository.setActiveOrganization({ id: sessionId, organizationId });
  },

  /** The second factor was passed: the session becomes fully usable and gets its normal lifetime. */
  async completeMfa(sessionId: string) {
    const cfg = getConfig().auth;
    await sessionsRepository.completeMfa({ id: sessionId, ttlMs: cfg.sessionTtlMs, maxAgeMs: cfg.sessionMaxAgeMs });
  },

  async markReauthenticated(sessionId: string) {
    await sessionsRepository.markReauthenticated({ id: sessionId });
  },

  async revoke(token: string) {
    await sessionsRepository.deleteByTokenHash({ tokenHash: hashSessionToken(token) });
  },

  async revokeAllForUser(userId: string) {
    await sessionsRepository.deleteAllForUser({ userId });
  },

  /** The caller's own live sessions, as safe summaries (no token, no token hash). */
  async listForUser(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const rows = await sessionsRepository.listLiveForUser({ userId, now: new Date() });
    return rows.map((s) => ({
      id: s.id,
      current: s.id === currentSessionId,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ip: maskIp(s.ipAddress),
      device: deviceLabel(s.userAgent),
      mfaVerified: !!s.mfaVerifiedAt,
    }));
  },

  /** Revokes one of the user's own sessions. False when it does not exist or is not theirs (indistinguishable). */
  async revokeOne(userId: string, sessionId: string): Promise<boolean> {
    return sessionsRepository.deleteByIdForUser({ id: sessionId, userId });
  },

  async revokeOthers(userId: string, keepSessionId: string): Promise<number> {
    return sessionsRepository.deleteOthersForUser({ userId, keepId: keepSessionId });
  },
};
