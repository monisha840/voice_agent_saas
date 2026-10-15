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

export const entitlementsSchema = z
  .object({
    maxConcurrentCalls: z.number().int().min(0),
    maxAgents: z.number().int().min(0),
    maxTeamMembers: z.number().int().min(0),
    retentionDays: z.number().int().min(0),
    analytics: z.enum(["none", "basic", "advanced"]),
    apiAccess: z.boolean(),
    webhooks: z.boolean(),
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

export function parseEntitlements(raw: unknown): Entitlements {
  const r = entitlementsSchema.safeParse(raw);
  return r.success ? r.data : {};
}

export function parseOverrides(raw: unknown): LimitOverrides {
  const r = limitOverridesSchema.safeParse(raw);
  return r.success ? r.data : {};
}

/**
 * What the platform actually enforces for each advertised entitlement. The UI only presents ENFORCED ones as plan
 * benefits. Keep in step with docs/billing/README.md.
 *  - includedMinutes, maxConcurrentCalls, subscription status: call admission (call-admission.ts)
 *  - maxAgents, maxTeamMembers: database triggers (migration 0020)
 *  - retentionDays: global operator configuration only; not plan-controlled
 *  - analytics: no tiered analytics exist
 *  - apiAccess, webhooks: no API-key or outbound-webhook feature exists
 */
export const ENTITLEMENT_ENFORCEMENT = {
  includedMinutes: "ENFORCED",
  maxConcurrentCalls: "ENFORCED",
  maxAgents: "ENFORCED",
  maxTeamMembers: "ENFORCED",
  retentionDays: "NOT_ENFORCED",
  analytics: "NOT_ENFORCED",
  apiAccess: "NOT_AVAILABLE",
  webhooks: "NOT_AVAILABLE",
} as const;
