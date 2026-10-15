/**
 * Password acceptance policy. Length-first (NIST SP 800-63B): no composition rules, but a minimum length, a maximum
 * that protects the hasher, a blocklist of the most common and context-specific passwords, and an optional
 * breached-password check against the Have I Been Pwned range API using k-anonymity: only the first 5 hex characters
 * of the SHA-1 leave this server, never the password. When that service is unreachable the configured mode decides:
 * "fail-open" accepts (and logs), "fail-closed" refuses.
 */
import { createHash } from "node:crypto";
import { getConfig } from "../config/env.js";
import { logger } from "../shared/logger.js";

export const MAX_PASSWORD_LENGTH = 128;

const COMMON = new Set(
  (
    "password,password1,password12,password123,password1234,passw0rd,p@ssw0rd,qwerty,qwerty123,qwertyuiop,123456,1234567," +
    "12345678,123456789,1234567890,12345678910,0123456789,1q2w3e4r,1q2w3e4r5t,iloveyou,welcome,welcome1,welcome123,admin," +
    "admin123,administrator,letmein,letmein123,monkey,dragon,football,baseball,abc123,abcd1234,changeme,changeme123,default," +
    "secret,trustno1,sunshine,princess,master,login,starwars,whatever,freedom,shadow,superman,batman,hello123,test1234," +
    "temp1234,pass1234,aaaaaaaa,00000000,11111111,111111111,qazwsx,zaq12wsx,asdfghjkl,zxcvbnm,india123,india@123,welcome@123," +
    "admin@123,password@123,voiceagent,voice-agent,voiceagent123,greenvalley,sirahdigital"
  ).split(","),
);

export type PasswordProblem = "too_short" | "too_long" | "too_common" | "contains_identity" | "breached" | "check_unavailable";

export interface PasswordCheckInput {
  password: string;
  email?: string | null;
  name?: string | null;
}

function identityTokens(input: PasswordCheckInput): string[] {
  const out: string[] = [];
  const local = input.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4) out.push(local);
  for (const part of (input.name ?? "").toLowerCase().split(/\s+/)) if (part.length >= 4) out.push(part);
  return out;
}

async function pwnedCount(password: string): Promise<number> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true", "User-Agent": "voice-agent-saas-password-check" },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`range api ${res.status}`);
  for (const line of (await res.text()).split("\n")) {
    const [hash, count] = line.trim().split(":");
    if (hash === suffix) return Number(count) || 1;
  }
  return 0;
}

/** Returns the reason a password is unacceptable, or null when it is fine. */
export async function checkPassword(input: PasswordCheckInput): Promise<PasswordProblem | null> {
  const cfg = getConfig().auth.passwords;
  const { password } = input;
  if (password.length < cfg.minLength) return "too_short";
  if (password.length > MAX_PASSWORD_LENGTH) return "too_long";
  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || /^(.)\1+$/.test(password)) return "too_common";
  for (const token of identityTokens(input)) if (lowered.includes(token)) return "contains_identity";
  if (cfg.pwned !== "off") {
    try {
      if ((await pwnedCount(password)) > 0) return "breached";
    } catch (err) {
      logger.warn("password-policy: breached-password service unavailable", {
        mode: cfg.pwned,
        error: err instanceof Error ? err.message : "unknown",
      });
      if (cfg.pwned === "fail-closed") return "check_unavailable";
    }
  }
  return null;
}

export const PASSWORD_PROBLEM_MESSAGE: Record<PasswordProblem, string> = {
  too_short: "Password is too short.",
  too_long: "Password is too long.",
  too_common: "That password is too common. Choose something longer and less predictable.",
  contains_identity: "Password must not contain your name or email address.",
  breached: "That password has appeared in a data breach. Choose a different one.",
  check_unavailable: "We could not verify that password right now. Please try again shortly.",
};
