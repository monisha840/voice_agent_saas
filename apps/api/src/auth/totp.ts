/**
 * TOTP (RFC 6238) on top of the maintained `otpauth` library: SHA-1, 6 digits, 30 s step, which every authenticator
 * app supports. Verification accepts the current step and one step either side (clock drift) and reports WHICH step
 * matched so the caller can refuse to accept the same step twice (replay protection).
 */
import * as OTPAuth from "otpauth";
import { getConfig } from "../config/env.js";

const PERIOD = 30;
const DIGITS = 6;

function totp(secretBase32: string, label: string) {
  return new OTPAuth.TOTP({
    issuer: getConfig().auth.mfa.issuer,
    label,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function generateSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function otpauthUri(secretBase32: string, accountLabel: string): string {
  return totp(secretBase32, accountLabel).toString();
}

/** The accepted time step (a number), or null when the code does not match. */
export function verifyCode(secretBase32: string, code: string, at: Date = new Date()): number | null {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  const delta = totp(secretBase32, "x").validate({ token: cleaned, timestamp: at.getTime(), window: 1 });
  if (delta === null) return null;
  return Math.floor(at.getTime() / 1000 / PERIOD) + delta;
}

/** Test helper: the code an authenticator app would show at a given moment. */
export function codeAt(secretBase32: string, at: Date): string {
  return totp(secretBase32, "x").generate({ timestamp: at.getTime() });
}
