/**
 * The read-only operator view of every customer: who exists, how big they are, what they have switched on, what they
 * are paying for and whether they are still calling. It is the cheap substitute for a super-admin dashboard, so it
 * answers "who is on what" without anyone opening a SQL client.
 *
 *   pnpm --filter @voice-agent/api org:list
 *   pnpm --filter @voice-agent/api org:list --json
 *
 * Needs DATABASE_ADMIN_URL (the administrative role): reading ACROSS tenants is deliberately impossible for the
 * application's own role, which row-level security confines to one organization.
 *
 * READ-ONLY by construction: one SELECT, and the subscription status is computed by the pure state function
 * (modules/billing/subscription-state.ts) rather than by the entitlement engine - the engine reconciles the usage
 * ledger as it reads, which would make a listing a write. The status shown is therefore the one in force NOW
 * (a lapsed trial reads "expired" even if no sweep has stored that yet); the stored status is shown when it differs.
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { pathToFileURL } from "node:url";
import { asc, eq, sql as raw } from "drizzle-orm";
import { adminDb, adminSql, sql } from "../db/client.js";
import { calls, memberships, organizationModules, organizations, plans, subscriptions } from "../db/schema.js";
import { getBillingPolicy } from "../modules/billing/billing-policy.js";
import { effectiveStatus } from "../modules/billing/subscription-state.js";
import type { SubscriptionStatus } from "../modules/billing/plan-types.js";

export interface OrgListRow {
  slug: string;
  name: string;
  members: number;
  /** Enabled module keys (an organization with none runs the always-on voice core only). */
  modules: string[];
  planKey: string | null;
  planName: string | null;
  /** The status in force now, or "unmanaged" for an organization with no subscription row (legacy). */
  status: SubscriptionStatus | "unmanaged";
  /** Set when time alone moved the status and the stored row has not been swept yet. */
  storedStatus: SubscriptionStatus | null;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  trialEndsAt: string | null;
  /** Start of the most recent call (its creation time when it never started). Null = never called. */
  lastCallAt: string | null;
  calls: number;
  createdAt: string;
}

/**
 * Correlated counts and the newest call, as SQL expressions. `.mapWith` hands the value to the matching column's own
 * decoder, because the drizzle driver turns off postgres.js's date parsing (raw timestamps would arrive as strings).
 */
const memberCount = raw<number>`(select count(*)::int from ${memberships} m where m.organization_id = ${organizations.id})`.mapWith(Number);
const callCount = raw<number>`(select count(*)::int from ${calls} c where c.organization_id = ${organizations.id})`.mapWith(Number);
const lastCallAt = raw`(select max(coalesce(c.started_at, c.created_at)) from ${calls} c where c.organization_id = ${organizations.id})`.mapWith(
  calls.startedAt,
);
const moduleKeys = raw<
  string[] | null
>`(select array_agg(om.module_key order by om.module_key) from ${organizationModules} om where om.organization_id = ${organizations.id} and om.enabled)`;

export async function listOrganizations(now = new Date()): Promise<OrgListRow[]> {
  if (!adminSql) throw new Error("DATABASE_ADMIN_URL is required for org:list (listing every tenant needs the administrative role)");
  const graceDays = getBillingPolicy().gracePeriodDays;
  const rows = await adminDb
    .select({
      slug: organizations.slug,
      name: organizations.name,
      createdAt: organizations.createdAt,
      members: memberCount,
      modules: moduleKeys,
      calls: callCount,
      lastCallAt,
      planKey: subscriptions.planKey,
      planName: plans.name,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      periodStart: subscriptions.currentPeriodStart,
      periodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      canceledAt: subscriptions.canceledAt,
    })
    .from(organizations)
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .leftJoin(plans, eq(plans.key, subscriptions.planKey))
    .orderBy(asc(organizations.createdAt));

  return rows.map((r) => {
    // No subscription row = the unmanaged legacy state the entitlement engine reports as UNMANAGED_LEGACY.
    const eff =
      r.status && r.planKey && r.periodStart && r.periodEnd
        ? effectiveStatus(
            {
              status: r.status,
              planKey: r.planKey,
              trialEndsAt: r.trialEndsAt,
              currentPeriodStart: r.periodStart,
              currentPeriodEnd: r.periodEnd,
              cancelAtPeriodEnd: r.cancelAtPeriodEnd ?? false,
              canceledAt: r.canceledAt,
            },
            now,
            graceDays,
          )
        : null;
    return {
      slug: r.slug,
      name: r.name,
      members: r.members,
      modules: r.modules ?? [],
      planKey: r.planKey,
      planName: r.planName,
      status: eff ? eff.status : ("unmanaged" as const),
      storedStatus: eff?.derivedFrom ?? null,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd ?? false,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
      lastCallAt: r.lastCallAt?.toISOString() ?? null,
      calls: r.calls,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "-");

/** Fixed-width table, widest cell per column. */
export function formatTable(rows: OrgListRow[]): string {
  const header = ["SLUG", "NAME", "MEMBERS", "MODULES", "PLAN", "STATUS", "PERIOD END", "CALLS", "LAST CALL"];
  const body = rows.map((r) => [
    r.slug,
    r.name,
    String(r.members),
    r.modules.join(",") || "-",
    r.planKey ?? "-",
    r.status + (r.storedStatus ? ` (stored ${r.storedStatus})` : "") + (r.cancelAtPeriodEnd ? " (cancelling)" : ""),
    day(r.periodEnd),
    String(r.calls),
    day(r.lastCallAt),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length), 0));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const asJson = process.argv.slice(2).includes("--json");
  listOrganizations()
    .then((rows) => {
      if (asJson) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log(formatTable(rows));
      const unmanaged = rows.filter((r) => r.status === "unmanaged").length;
      console.log(
        `\n${rows.length} organization(s); ${unmanaged} unmanaged (no subscription row). ` +
          `Statuses are the ones in force now; "(stored X)" means time alone has moved it and the row has not been swept.`,
      );
    })
    .catch((err) => {
      console.error(`org:list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
      await adminSql?.end();
    });
}
