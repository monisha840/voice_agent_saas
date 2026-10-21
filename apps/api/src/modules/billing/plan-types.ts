/**
 * Plan configuration vs tenant state.
 *
 *  - A PLAN (db table `plans`) is configuration: price, included minutes and entitlements. It never changes per tenant.
 *  - A SUBSCRIPTION (`subscriptions`) is a tenant's state: which plan, status, period, cancellation, and optional
 *    negotiated `limitOverrides` (Enterprise).
 *
 * Nothing in the UI or the business logic hard-codes a price or a limit: both read these shapes.
 */
import { z } from "zod";

/**
 * Every key here is an entitlement the platform actually enforces; each one needs an explicit status in
 * ENTITLEMENT_ENFORCEMENT below (guard test) and a row in docs/billing/entitlement-enforcement-matrix.md.
 *
 * Deliberately NOT here (decision D3, 2026-10-21: removed, never implemented -- `retentionDays`, `analytics`,
 * `apiAccess`, `webhooks`). They were advertised in the seeded plan JSON while nothing in the product checked them;
 * migration 0025 strips them from `plans`. Do not re-add a key here before a server-side gate and a test exist for
 * it. This object is NOT strict: a stale key still sitting in stored JSON (an old `limit_overrides`, a hand-edited
 * plan row) is stripped on read rather than rejected, so it can neither grant nor refuse anything.
 */
export const entitlementsSchema = z
  .object({
    maxConcurrentCalls: z.number().int().min(0),
    maxAgents: z.number().int().min(0),
    maxTeamMembers: z.number().int().min(0),
  })
  .partial();

/** Negotiated overrides on a subscription: any entitlement plus the included minutes. */
export const limitOverridesSchema = entitlementsSchema.extend({ includedMinutes: z.number().int().min(0).optional() });

export type Entitlements = z.infer<typeof entitlementsSchema>;
export type LimitOverrides = z.infer<typeof limitOverridesSchema>;

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "suspended" | "canceled" | "expired";

export interface PlanView {
  key: string;
  name: string;
  description: string;
  /** Integer paise; null = custom pricing (contact sales). */
  pricePaise: number | null;
  currency: string;
  billingInterval: string;
  includedMinutes: number;
  trialDays: number | null;
  entitlements: Entitlements;
  /** Whether the plan can be chosen without talking to sales. A custom-priced plan (null price) never can. */
  selfServe: boolean;
}

/** What a caller can do next. Drives the UI's primary action. */
export type NextStep = "none" | "upgrade" | "contact_sales" | "update_payment" | "wait_for_next_period";

/** Structured, UI-explainable reasons (stable strings). */
export type EntitlementReason =
  | "OK"
  | "UNMANAGED_LEGACY"
  | "ENFORCEMENT_DISABLED"
  | "TRIAL_EXPIRED"
  | "SUBSCRIPTION_SUSPENDED"
  | "SUBSCRIPTION_CANCELED"
  | "SUBSCRIPTION_EXPIRED"
  | "MINUTES_EXHAUSTED"
  | "CONCURRENT_CALL_LIMIT"
  | "PLAN_UNAVAILABLE"
  | "LIMITS_NOT_CONFIGURED"
  | "STATE_UNAVAILABLE";

/** Tolerant by design: unknown/stale keys are ignored (stripped), a malformed value falls back to "no limits set". */
export function parseEntitlements(raw: unknown): Entitlements {
  const r = entitlementsSchema.safeParse(raw);
  return r.success ? r.data : {};
}

/**
 * Tolerant by design: a subscription whose `limit_overrides` still carries a removed key (`retentionDays`,
 * `analytics`, `apiAccess`, `webhooks`) parses fine -- the key is ignored -- so reading an old row never throws and
 * never loses the negotiated limits stored next to it.
 */
export function parseOverrides(raw: unknown): LimitOverrides {
  const r = limitOverridesSchema.safeParse(raw);
  return r.success ? r.data : {};
}

/**
 * What the platform actually enforces for each advertised entitlement. Every key is ENFORCED: an unenforced
 * entitlement is not advertised at all (decision D3). Keep in step with docs/billing/README.md and
 * docs/billing/entitlement-enforcement-matrix.md.
 *  - includedMinutes, maxConcurrentCalls, subscription status: call admission (call-admission.ts)
 *  - maxAgents, maxTeamMembers: database triggers (migration 0020)
 *
 * Removed 2026-10-21, never implemented (migration 0025 strips them from `plans`): `retentionDays` (retention is one
 * global operator setting, not plan-controlled), `analytics` (no tiered analytics exist), `apiAccess` and `webhooks`
 * (no API-key or outbound-webhook feature exists). A key goes back in here only together with a real gate and a test.
 */
export const ENTITLEMENT_ENFORCEMENT = {
  includedMinutes: "ENFORCED",
  maxConcurrentCalls: "ENFORCED",
  maxAgents: "ENFORCED",
  maxTeamMembers: "ENFORCED",
} as const;

/** Keys that were advertised but never enforced, removed on 2026-10-21. The guard tests assert they stay gone. */
export const REMOVED_ENTITLEMENTS = ["retentionDays", "analytics", "apiAccess", "webhooks"] as const;
