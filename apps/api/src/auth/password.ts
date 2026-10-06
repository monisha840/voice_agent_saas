/**
 * Password hashing with scrypt (Node built-in: no native dependency, works
 * unchanged on Windows, Docker and hosted runtimes). The cost parameters are
 * stored inside each hash, so the cost can be raised later without
 * invalidating existing passwords.
 *
 * Format: scrypt$N$r$p$<salt b64>$<hash b64>
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { getConfig } from "../config/env.js";

const KEY_LEN = 32;
const R = 8;
const P = 1;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const n = getConfig().auth.scryptN;
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, n, R, P);
  return `scrypt$${n}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  try {
    const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies against a throwaway hash so "unknown email" takes as long as
 * "wrong password" (no account enumeration through response timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummyHash);
}

/** A random password nobody knows — for accounts that must never log in with a password (e.g. the demo user). */
export async function hashUnguessablePassword(): Promise<string> {
  return hashPassword(randomBytes(32).toString("hex"));
}
