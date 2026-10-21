/**
 * Per-call media-stream tokens.
 *
 * WHAT THIS AUTHENTICATES: that the party opening a media-stream WebSocket was handed THIS call's stream URL by our
 * own API when the call was created, for THIS organization, and that it is still within that call's window. It does
 * NOT prove the peer is Exotel (anyone who learns the URL can present it until it expires or hits its use limit) and
 * it is not a webhook signature: provider callbacks (status-callback, inbound) are authenticated separately by the
 * shared webhook secret (security/telephony-auth.ts). The two mechanisms are independent and neither substitutes for
 * the other.
 *
 * Format: a compact JWS (HS256) produced and verified by the `jose` library:
 *   header  { alg: HS256, typ: "JWT", kid }
 *   claims  { iss, aud, sub: <call id>, org: <organization id>, prv: <provider>, jti, iat, nbf, exp }
 *
 * Keys: STREAM_TOKEN_KEYS = "<kid>:<base64 secret>[,<kid>:<base64 secret>...]". The FIRST entry signs; every entry
 * verifies, so rotation is: add a new key first, deploy, wait one token TTL, drop the old one. Secrets must decode to
 * at least 32 bytes. Without configured keys a development process generates a throw-away key (tokens then do not
 * survive a restart or work across instances); production validation refuses to start with the Exotel provider and no
 * keys.
 *
 * Tokens are bearer credentials in a URL: they are never logged (see logger/redactUrl), never echoed in an error and
 * are short-lived. Single-use is NOT enforced (providers legitimately reconnect); instead a token may open a bounded
 * number of connections (STREAM_TOKEN_MAX_USES), counted in the database so the limit holds across instances.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { getConfig } from "../config/env.js";

const ISSUER = "voice-engine";
const AUDIENCE = "voice-engine:media-stream";
const TOKEN_TYPE = "media-stream";

export type StreamTokenFailure =
  | "missing"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_type"
  | "bad_claims";

export class StreamTokenError extends Error {
  constructor(public readonly reason: StreamTokenFailure) {
    super(`stream token rejected: ${reason}`);
    this.name = "StreamTokenError";
  }
}

export interface StreamClaims {
  /** The call the stream is for. */
  callId: string;
  /** The organization that owns the call (the stream must resolve to a call in this organization). */
  organizationId: string;
  provider: string;
  jti: string;
  expiresAt: Date;
}

interface KeyRing {
  signingKid: string;
  keys: Map<string, Uint8Array>;
}

let ephemeral: KeyRing | null = null;

function parseKeys(raw: string): KeyRing {
  const keys = new Map<string, Uint8Array>();
  let signingKid = "";
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(":");
    if (sep <= 0) throw new Error("STREAM_TOKEN_KEYS entries must look like <kid>:<base64 secret>");
    const kid = entry.slice(0, sep);
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(kid)) throw new Error("STREAM_TOKEN_KEYS: key ids may use letters, digits, '_', '.', '-' (max 32)");
    const secret = Buffer.from(entry.slice(sep + 1), "base64");
    if (secret.length < 32) throw new Error(`STREAM_TOKEN_KEYS: key "${kid}" must decode to at least 32 bytes`);
    keys.set(kid, new Uint8Array(secret));
    if (!signingKid) signingKid = kid;
  }
  if (keys.size === 0) throw new Error("STREAM_TOKEN_KEYS is empty");
  return { signingKid, keys };
}

function keyRing(): KeyRing {
  const raw = getConfig().stream.tokenKeys;
  if (raw) return parseKeys(raw);
  ephemeral ??= { signingKid: "ephemeral", keys: new Map([["ephemeral", new Uint8Array(randomBytes(32))]]) };
  return ephemeral;
}

/** True when real keys are configured (as opposed to the throw-away development key). */
export function streamTokenKeysConfigured(): boolean {
  return getConfig().stream.tokenKeys.trim().length > 0;
}

export async function issueStreamToken(params: {
  callId: string;
  organizationId: string;
  provider: string;
  now?: Date;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const cfg = getConfig().stream;
  const ring = keyRing();
  const now = params.now ?? new Date();
  const jti = randomUUID();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + Math.max(30, Math.floor(cfg.tokenTtlMs / 1000));
  const token = await new SignJWT({ org: params.organizationId, prv: params.provider, typ2: TOKEN_TYPE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring.signingKid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(params.callId)
    .setJti(jti)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .sign(ring.keys.get(ring.signingKid)!);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifies signature, expiry, audience and claim shape. Throws StreamTokenError (reason only, never the token). */
export async function verifyStreamToken(token: unknown, now: Date = new Date()): Promise<StreamClaims> {
  if (typeof token !== "string" || token.length === 0) throw new StreamTokenError("missing");
  if (token.length > 2048 || token.split(".").length !== 3) throw new StreamTokenError("malformed");
  const ring = keyRing();
  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const key = header.kid ? ring.keys.get(header.kid) : undefined;
        if (!key) throw new StreamTokenError("unknown_key");
        return key;
      },
      { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], currentDate: now, clockTolerance: 5 },
    );
    const callId = payload.sub;
    const organizationId = payload.org;
    const provider = payload.prv;
    const jti = payload.jti;
    if (payload.typ2 !== TOKEN_TYPE) throw new StreamTokenError("wrong_type");
    if (
      typeof callId !== "string" ||
      !UUID.test(callId) ||
      typeof organizationId !== "string" ||
      !UUID.test(organizationId) ||
      typeof provider !== "string" ||
      typeof jti !== "string" ||
      typeof payload.exp !== "number"
    ) {
      throw new StreamTokenError("bad_claims");
    }
    return { callId, organizationId, provider, jti, expiresAt: new Date(payload.exp * 1000) };
  } catch (err) {
    if (err instanceof StreamTokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new StreamTokenError("expired");
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === "iss") throw new StreamTokenError("wrong_issuer");
      if (err.claim === "aud") throw new StreamTokenError("wrong_audience");
      if (err.claim === "nbf") throw new StreamTokenError("not_yet_valid");
      throw new StreamTokenError("bad_claims");
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) throw new StreamTokenError("bad_signature");
    if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JOSEAlgNotAllowed) {
      throw new StreamTokenError("malformed");
    }
    throw new StreamTokenError("malformed");
  }
}
