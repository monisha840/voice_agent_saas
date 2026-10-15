/**
 * Authenticated encryption for small secrets at rest (TOTP seeds): AES-256-GCM with a random 96-bit nonce per value.
 * The key comes from the deployment (MFA_ENCRYPTION_KEY, base64 of 32 random bytes), never from source code. A value
 * is bound to a context string (the user id) so a ciphertext copied onto another account does not decrypt.
 *
 * Format: v1.<nonce b64url>.<ciphertext b64url>.<tag b64url>
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "../config/env.js";

export class SecretBoxUnavailableError extends Error {
  constructor() {
    super("MFA_ENCRYPTION_KEY is not configured (base64 of 32 random bytes)");
  }
}

function key(): Buffer {
  const raw = getConfig().auth.mfa.encryptionKey;
  if (!raw) throw new SecretBoxUnavailableError();
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return k;
}

export function isSecretBoxConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function open(sealed: string, context: string): string {
  const [v, n, c, t] = sealed.split(".");
  if (v !== "v1" || !n || !c || !t) throw new Error("Unrecognised sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(n, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(t, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(c, "base64url")), decipher.final()]).toString("utf8");
}
