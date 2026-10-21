/**
 * Assigns or changes an organization's subscription. This is the operator counterpart of self-service billing: a
 * customer cannot put themselves on a paid plan (no payment gateway is wired up, see modules/billing/billing.service.ts),
 * so a real customer is activated here instead of with hand-written SQL.
 *
 *   ORG=<slug|uuid> PLAN=<plan key> [STATUS=active|trialing] [PERIOD_DAYS=30] [TRIAL_DAYS=14] \
 *   [LIMIT_OVERRIDES='{"maxConcurrentCalls":50,"includedMinutes":20000}'] [REASON="PO-1234"] [OPERATOR=jane] \
 *     pnpm --filter @voice-agent/api billing:assign-subscription
 *
 * Needs DATABASE_ADMIN_URL (the administrative role). Both cases are handled: an organization with NO subscription
 * row (the unmanaged legacy state) gets one, an organization that already has one is moved to the new plan.
 *
 * Nothing about plans is hard-coded here: the plan key is looked up in the `plans` table, the period comes from the
 * plan's own billing_interval / trial_days, the overrides are validated by the billing domain's own schema, and the
 * result is re-read through the entitlement engine. A combination the engine would refuse (LIMITS_NOT_CONFIGURED -
 * an Enterprise plan with no negotiated limits) is refused HERE, before anything is written, because an organization
 * with a broken subscription is worse off than one with none at all (no row = unmanaged = calls still allowed).
 *
 * The lifecycle statuses an operator must NOT hand-set (past_due, suspended, canceled, expired) are rejected: they
 * are outcomes of the state machine (subscription-state.ts), of a verified payment event, or of the owner's own
 * cancel action - never of a script.
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { adminSql, sql } from "../db/client.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { auditRepository } from "../db/repositories/audit.repository.js";
import { organizationsRepository } from "../db/repositories/organizations.repository.js";
import { plansRepository, subscriptionsRepository, type PlanRow, type SubscriptionRow } from "../db/repositories/billing.repository.js";
import { sanitizeMetadata } from "../modules/audit/audit.service.js";
import { evaluateEntitlements } from "../modules/billing/entitlements-engine.js";
import { limitOverridesSchema, parseEntitlements, parseOverrides, type LimitOverrides } from "../modules/billing/plan-types.js";
import { applyEvent, InvalidTransitionError } from "../modules/billing/subscription-state.js";
import { securityEvents } from "../security/security-events.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses an operator may assign. Everything else is a lifecycle outcome, not an operator decision. */
const ASSIGNABLE = ["active", "trialing"] as const;
export type AssignableStatus = (typeof ASSIGNABLE)[number];

export interface AssignSubscriptionInput {
  /** Organization slug or id. */
  org: string;
  planKey: string;
  /** Default: trialing for a plan with trial days, active otherwise. */
  status?: string;
  /** Length of the paid period in days; default comes from the plan's billing_interval. */
  periodDays?: number;
  /** Trial length in days; default comes from the plan's trial_days. */
  trialDays?: number;
  /**
   * Negotiated entitlement overrides, as JSON. Omitted on an organization that already has a subscription KEEPS the
   * overrides it has (a plan change must not silently drop negotiated limits); pass '{}' to clear them.
   */
  limitOverrides?: string;
  operator: string;
  reason?: string;
  now?: Date;
}

export interface AssignSubscriptionResult {
  organizationId: string;
  slug: string;
  planKey: string;
  previousPlanKey: string | null;
  status: AssignableStatus;
  created: boolean;
  periodStart: string;
  periodEnd: string;
  trialEndsAt: string | null;
  limitOverrides: LimitOverrides;
  /** What the entitlement engine says about the organization after the change. */
  entitlement: { allowed: boolean; reason: string; includedMinutes: number; maxConcurrentCalls: number | null };
}

/** The plan's own period length, used when the caller gives no PERIOD_DAYS. */
function periodEndFor(plan: PlanRow, from: Date, periodDays?: number): Date {
  if (periodDays !== undefined) return new Date(from.getTime() + periodDays * 86_400_000);
  const d = new Date(from);
  if (plan.billingInterval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (plan.billingInterval === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1); // "month" (the catalog's default)
  return d;
}

/**
 * The entitlement engine's own refusal conditions, checked before writing (entitlements-engine.ts, evaluateWith):
 * a missing/zero maxConcurrentCalls, or a custom-priced plan with no negotiated includedMinutes, is
 * LIMITS_NOT_CONFIGURED; zero included minutes is MINUTES_EXHAUSTED from the first call. Either way the organization
 * could not place a call, so the subscription would be broken on arrival.
 */
export function limitsProblem(plan: PlanRow, overrides: LimitOverrides): string | null {
  const limits = { ...parseEntitlements(plan.entitlements), ...overrides };
  const includedMinutes = overrides.includedMinutes ?? plan.includedMinutes;
  if (!limits.maxConcurrentCalls) {
    return `plan "${plan.key}" sets no maxConcurrentCalls: the entitlement engine would answer LIMITS_NOT_CONFIGURED`;
  }
  if (plan.pricePaise === null && overrides.includedMinutes === undefined) {
    return `plan "${plan.key}" has custom pricing, so includedMinutes must be negotiated: the entitlement engine would answer LIMITS_NOT_CONFIGURED`;
  }
  if (includedMinutes <= 0) {
    return `the resulting includedMinutes is ${includedMinutes}: every call would be refused with MINUTES_EXHAUSTED`;
  }
  return null;
}

function parseLimitOverrides(raw: string | undefined, existing: SubscriptionRow | null): LimitOverrides {
  if (raw === undefined || raw.trim() === "") return existing ? parseOverrides(existing.limitOverrides) : {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("LIMIT_OVERRIDES is not valid JSON");
  }
  const parsed = limitOverridesSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`LIMIT_OVERRIDES is not a valid override set - ${where}`);
  }
  return parsed.data;
}

export async function assignSubscription(input: AssignSubscriptionInput): Promise<AssignSubscriptionResult> {
  const orgRef = input.org?.trim() ?? "";
  if (!orgRef) throw new Error("ORG is required (an organization slug or id)");
  const planKey = input.planKey?.trim() ?? "";
  if (!planKey) throw new Error("PLAN is required (a key from the plans table)");

  const org = UUID.test(orgRef)
    ? await organizationsRepository.findById({ id: orgRef })
    : await organizationsRepository.findBySlug({ slug: orgRef.toLowerCase() });
  if (!org) throw new Error(`No organization with slug or id "${orgRef}"`);

  // The catalog is the authority on which plans exist - never a list in this script.
  const plan = await plansRepository.get({ key: planKey });
  if (!plan) {
    const available = (await plansRepository.list()).map((p) => p.key).join(", ");
    throw new Error(`No plan with key "${planKey}". Active plans: ${available}`);
  }
  if (!plan.isActive) throw new Error(`Plan "${plan.key}" is not active; choose a current plan`);

  const existing = await subscriptionsRepository.find({ organizationId: org.id });
  const overrides = parseLimitOverrides(input.limitOverrides, existing);

  const trialDays = input.trialDays ?? plan.trialDays ?? 0;
  const requested = input.status?.trim() || (trialDays > 0 ? "trialing" : "active");
  if (!(ASSIGNABLE as readonly string[]).includes(requested)) {
    throw new Error(`STATUS must be one of ${ASSIGNABLE.join(", ")} (a lifecycle status is never assigned by hand)`);
  }
  const status = requested as AssignableStatus;
  if (status === "trialing" && trialDays <= 0) {
    throw new Error(`STATUS=trialing needs trial days: plan "${plan.key}" has none, so pass TRIAL_DAYS explicitly`);
  }

  const problem = limitsProblem(plan, overrides);
  if (problem) {
    throw new Error(
      `Refusing to create a subscription that cannot place a call: ${problem}. ` +
        `Pass the negotiated limits in LIMIT_OVERRIDES (e.g. '{"maxConcurrentCalls":10,"includedMinutes":5000}'), ` +
        `or leave the organization unmanaged until they are agreed.`,
    );
  }

  const now = input.now ?? new Date();
  const periodStart = now;
  const trialEndsAt = status === "trialing" ? new Date(now.getTime() + trialDays * 86_400_000) : (existing?.trialEndsAt ?? null);
  const periodEnd = status === "trialing" ? trialEndsAt! : periodEndFor(plan, periodStart, input.periodDays);
  if (periodEnd.getTime() <= periodStart.getTime()) throw new Error("The billing period would end before it starts; check PERIOD_DAYS / TRIAL_DAYS");

  let row: SubscriptionRow | null;
  if (!existing) {
    // Unmanaged legacy organization: give it its first subscription. Idempotent on organization_id, so a racing
    // writer cannot produce two.
    row = await subscriptionsRepository.insert({
      organizationId: org.id,
      values: {
        planKey: plan.key,
        status,
        trialEndsAt: status === "trialing" ? trialEndsAt : null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        limitOverrides: overrides,
      },
    });
    if (!row) throw new Error("This organization gained a subscription while this script was running; re-run to change it");
  } else {
    // An active assignment is exactly the state machine's "a payment arrived for this plan and period" transition,
    // so it is computed by the domain (subscription-state.ts) rather than written as SQL: it also clears a pending
    // cancellation and the cancellation timestamp. A trial assignment has no such event (billing.service.startTrial
    // writes it directly), so it is set the same way that does.
    const set =
      status === "active"
        ? (() => {
            try {
              const next = applyEvent(
                {
                  status: existing.status,
                  planKey: existing.planKey,
                  trialEndsAt: existing.trialEndsAt,
                  currentPeriodStart: existing.currentPeriodStart,
                  currentPeriodEnd: existing.currentPeriodEnd,
                  cancelAtPeriodEnd: existing.cancelAtPeriodEnd,
                  canceledAt: existing.canceledAt,
                },
                { type: "payment_succeeded", planKey: plan.key, periodStart, periodEnd },
                now,
              );
              return {
                status: next.status,
                planKey: next.planKey,
                currentPeriodStart: next.currentPeriodStart,
                currentPeriodEnd: next.currentPeriodEnd,
                cancelAtPeriodEnd: next.cancelAtPeriodEnd,
                canceledAt: next.canceledAt,
                scheduledPlanKey: null, // the requested change has now happened
                limitOverrides: overrides,
              };
            } catch (err) {
              if (err instanceof InvalidTransitionError) throw new Error(`Cannot assign this plan: ${err.message}`);
              throw err;
            }
          })()
        : {
            status,
            planKey: plan.key,
            trialEndsAt,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: false,
            canceledAt: null,
            scheduledPlanKey: null,
            limitOverrides: overrides,
          };
    row = await subscriptionsRepository.updateIfUnchanged({ organizationId: org.id, expectedUpdatedAt: existing.updatedAt, set });
    if (!row) throw new Error("This subscription changed while this script was running; re-run to see the current state");
  }

  const metadata = {
    operator: input.operator,
    reason: input.reason ?? null,
    plan: plan.key,
    previousPlan: existing?.planKey ?? null,
    previousStatus: existing?.status ?? null,
    status: row.status,
    periodStart: row.currentPeriodStart.toISOString(),
    periodEnd: row.currentPeriodEnd.toISOString(),
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    limitOverrides: overrides,
  };
  // Two trails, as the rest of the platform keeps them: the tenant's own audit log (their owner can read it) and the
  // security log of privileged actions taken from outside the application.
  await auditRepository.insert({
    organizationId: org.id,
    actorType: "system",
    actorSource: "operator-cli",
    action: existing ? "subscription.plan_assigned_by_operator" : "subscription.created_by_operator",
    entityType: "subscription",
    entityId: row.id,
    metadata: sanitizeMetadata(metadata) as Record<string, unknown>,
  });
  await securityEvents.record({
    type: "system.privileged_action",
    outcome: "success",
    organizationId: org.id,
    metadata: { action: existing ? "subscription.plan_assigned" : "subscription.created", ...metadata },
  });

  // Read the result back through the engine the product actually enforces, so a broken assignment cannot pass unseen.
  const snapshot = await evaluateEntitlements(org.id, now);
  return {
    organizationId: org.id,
    slug: org.slug,
    planKey: row.planKey,
    previousPlanKey: existing?.planKey ?? null,
    status,
    created: !existing,
    periodStart: row.currentPeriodStart.toISOString(),
    periodEnd: row.currentPeriodEnd.toISOString(),
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    limitOverrides: overrides,
    entitlement: {
      allowed: snapshot.allowed,
      reason: snapshot.reason,
      includedMinutes: snapshot.usage.includedMinutes,
      maxConcurrentCalls: snapshot.limits.maxConcurrentCalls ?? null,
    },
  };
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 3650) throw new Error(`${name} must be a whole number of days between 1 and 3650`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (!adminSql) throw new Error("DATABASE_ADMIN_URL is required for billing:assign-subscription");
    return runAsAdmin(() =>
      assignSubscription({
        org: process.env.ORG ?? "",
        planKey: process.env.PLAN ?? "",
        status: process.env.STATUS,
        periodDays: intEnv("PERIOD_DAYS"),
        trialDays: intEnv("TRIAL_DAYS"),
        limitOverrides: process.env.LIMIT_OVERRIDES,
        operator: process.env.OPERATOR || userInfo().username,
        reason: process.env.REASON,
      }),
    );
  })()
    .then((r) => {
      console.log(
        `${r.created ? "Created" : "Changed"} the subscription of "${r.slug}": ` +
          `${r.previousPlanKey ? `${r.previousPlanKey} -> ` : ""}${r.planKey} (${r.status}).`,
      );
      console.log(`Period: ${r.periodStart} -> ${r.periodEnd}${r.trialEndsAt ? ` (trial ends ${r.trialEndsAt})` : ""}.`);
      console.log(
        `Entitlements now: allowed=${r.entitlement.allowed} reason=${r.entitlement.reason} ` +
          `includedMinutes=${r.entitlement.includedMinutes} maxConcurrentCalls=${r.entitlement.maxConcurrentCalls ?? "unset"}.`,
      );
      if (Object.keys(r.limitOverrides).length > 0) console.log(`Negotiated overrides: ${JSON.stringify(r.limitOverrides)}.`);
      if (!r.entitlement.allowed) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`billing:assign-subscription failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
      await adminSql?.end();
    });
}
