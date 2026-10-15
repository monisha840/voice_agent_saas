/**
 * Failed-login throttling, shared across API instances (counters live in PostgreSQL, keyed by SHA-256 so no
 * plaintext email or IP is stored).
 *
 * Three independent counters, escalating and bounded - there is deliberately NO permanent lock-out:
 *  - (account, IP) pair:   the strict one. After `pairThreshold` failures that pair is locked for baseLockMs,
 *                          doubling per further failure up to maxLockMs. An attacker can only ever lock out their OWN
 *                          address for that account, never the real owner coming from somewhere else.
 *  - IP:                   one address spraying many accounts is slowed the same way (ipThreshold).
 *  - account (all IPs):    a distributed attack on one account adds a SHORT bounded delay (at most
 *                          ACCOUNT_MAX_DELAY_MS) - enough to make guessing impractical, never enough to deny
 *                          service to the owner.
 * Attempts made while locked are refused WITHOUT checking the password and do not extend the lock.
 * A successful login clears only that pair's counter.
 */
import { createHash } from "node:crypto";
import { getConfig } from "../config/env.js";
import { authThrottleRepository } from "../db/repositories/security.repository.js";

export const ACCOUNT_MAX_DELAY_MS = 30_000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const keys = (email: string, ip: string) => {
  const e = email.trim().toLowerCase();
  const addr = ip || "unknown";
  return { pair: hash(`pair:${e}|${addr}`), ip: hash(`ip:${addr}`), account: hash(`acct:${e}`) };
};

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the next attempt may be made (only when not allowed). */
  retryAfterSec: number;
  scope?: "pair" | "ip" | "account";
}

export const loginThrottle = {
  async check(email: string, ip: string, now: Date = new Date()): Promise<ThrottleDecision> {
    const k = keys(email, ip);
    const rows = await authThrottleRepository.get([k.pair, k.ip, k.account]);
    let worst: ThrottleDecision = { allowed: true, retryAfterSec: 0 };
    for (const row of rows) {
      if (!row.lockedUntil || row.lockedUntil.getTime() <= now.getTime()) continue;
      const sec = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000);
      if (sec > worst.retryAfterSec) {
        worst = { allowed: false, retryAfterSec: sec, scope: row.key === k.pair ? "pair" : row.key === k.ip ? "ip" : "account" };
      }
    }
    return worst;
  },

  async recordFailure(email: string, ip: string, now: Date = new Date()): Promise<void> {
    const cfg = getConfig().auth.throttle;
    const k = keys(email, ip);
    const plan: Array<{ key: string; threshold: number; maxLockMs: number }> = [
      { key: k.pair, threshold: cfg.pairThreshold, maxLockMs: cfg.maxLockMs },
      { key: k.ip, threshold: cfg.ipThreshold, maxLockMs: cfg.maxLockMs },
      { key: k.account, threshold: cfg.accountThreshold, maxLockMs: Math.min(cfg.maxLockMs, ACCOUNT_MAX_DELAY_MS) },
    ];
    for (const p of plan) {
      const failures = await authThrottleRepository.bump({ key: p.key, windowMs: cfg.windowMs });
      if (failures >= p.threshold) {
        const exponent = Math.min(failures - p.threshold, 16);
        const lockMs = Math.min(cfg.baseLockMs * 2 ** exponent, p.maxLockMs);
        await authThrottleRepository.lockUntil({ key: p.key, until: new Date(now.getTime() + lockMs) });
      }
    }
  },

  async recordSuccess(email: string, ip: string): Promise<void> {
    await authThrottleRepository.clear(keys(email, ip).pair);
  },
};
