/**
 * Per-call stream grants for the Exotel Voicebot applet's "dynamic endpoint" (opt-in; nothing changes unless the
 * applet is pointed at /api/telephony/exotel/stream-url). The endpoint, authenticated by the shared webhook secret,
 * resolves the call and returns {"url": "wss://.../media-stream?g=<grant>"}. The grant is a short opaque reference
 * (128 random bits, 22 base64url chars) rather than the signed `st` JWT because Exotel limits the applet URL length.
 * Only sha256(grant) is stored (table stream_grants). The grant is bound to ONE call and its provider call id, expires
 * (STREAM_GRANT_TTL_MS) and is use-bounded (STREAM_GRANT_MAX_USES). It never contains or implies the shared secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config/env.js";
import { streamGrantsRepository } from "../db/repositories/security.repository.js";

export function hashGrant(grant: string): string {
  return createHash("sha256").update(grant).digest("hex");
}

/** Only well-formed grants are looked up (22 base64url chars); anything else is rejected without touching the database. */
export function isWellFormedGrant(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export async function mintStreamGrant(params: { callId: string; providerCallId: string }): Promise<{ grant: string; expiresAt: Date }> {
  const grant = randomBytes(16).toString("base64url");
  const expiresAt = new Date(Date.now() + getConfig().stream.grantTtlMs);
  await streamGrantsRepository.insert({ grantHash: hashGrant(grant), callId: params.callId, providerCallId: params.providerCallId, expiresAt });
  return { grant, expiresAt };
}
