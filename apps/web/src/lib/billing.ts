import { ApiError, apiBase } from "./api";

/** Types and client for the billing endpoints (/api/billing/*). All money is integer paise, shown in INR. */

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "suspended" | "canceled" | "expired";
export type NextStep = "none" | "upgrade" | "contact_sales" | "update_payment" | "wait_for_next_period";

export interface Plan {
  key: string;
  name: string;
  description: string;
  pricePaise: number | null;
  currency: string;
  billingInterval: string;
  includedMinutes: number;
  trialDays: number | null;
  // Only the entitlements the server actually enforces. retentionDays, analytics, apiAccess and
  // webhooks were removed by migration 0025 (D3): they were advertised but never enforced, so the
  // API no longer sends them. See docs/billing/entitlement-enforcement-matrix.md.
  entitlements: {
    maxConcurrentCalls?: number;
    maxAgents?: number;
    maxTeamMembers?: number;
  };
  selfServe: boolean;
}

export interface BillingOverview {
  managed: boolean;
  allowed: boolean;
  reason: string;
  nextStep: NextStep;
  message: string;
  status: SubscriptionStatus | null;
  plan: Plan | null;
  trialEndsAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlanKey: string | null;
  limits: Plan["entitlements"];
  usage: {
    includedMinutes: number;
    usedMinutes: number;
    remainingMinutes: number;
    usedSeconds: number;
    calls: number;
    pendingEntries: number;
    roundingPolicy: string;
  };
  seats: { agents: { used: number; limit: number | null }; teamMembers: { used: number; limit: number | null } };
  paymentsEnabled: boolean;
  canManage: boolean;
}

export interface UsageEntry {
  id: string;
  callId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  occurredAt: string;
  durationSeconds: number;
  billableSeconds: number;
  billableMinutes: number;
  billableReason: string;
  outcome: string;
  terminationReason: string | null;
  state: "pending" | "final" | "superseded";
  entryType: "call" | "correction";
}

export interface UsagePage {
  data: UsageEntry[];
  nextCursor: string | null;
}

export interface PlanChangeResult {
  requestedPlanKey: string;
  effective: boolean;
  nextStep: string;
  message: string;
}

/** Browser/server client. On the Next server `getHeaders` supplies the session cookie. */
export function createBillingApi(getHeaders: () => Promise<Record<string, string>> | Record<string, string> = () => ({})) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const extra = await getHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string } & Record<string, unknown>;
    if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status, json.code);
    return json as T;
  }
  return {
    overview: async () => (await call<{ data: BillingOverview }>("GET", "/api/billing/overview")).data,
    plans: async () => (await call<{ data: Plan[] }>("GET", "/api/billing/plans")).data,
    usage: (cursor?: string) =>
      call<UsagePage>("GET", `/api/billing/usage?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    startTrial: async () => (await call<{ data: BillingOverview }>("POST", "/api/billing/trial", {})).data,
    requestPlanChange: async (planKey: string) =>
      (await call<{ data: PlanChangeResult }>("POST", "/api/billing/plan-change", { planKey })).data,
    cancel: async () => (await call<{ data: unknown }>("POST", "/api/billing/cancel", {})).data,
    resume: async () => (await call<{ data: unknown }>("POST", "/api/billing/resume", {})).data,
  };
}

/** ₹2,999 (whole rupees) or ₹2,999.50. Null = custom pricing. */
export function formatInr(paise: number | null): string {
  if (paise === null) return "Custom pricing";
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTimeIst(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** 125 -> "2:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Payment due",
  suspended: "Suspended",
  canceled: "Canceled",
  expired: "Expired",
};

export const REASON_LABEL: Record<string, string> = {
  billed: "Billed",
  unanswered: "Not answered",
  failed: "Failed",
  too_short: "Too short to bill",
  test_call: "Test call (free)",
  interrupted: "Awaiting end time",
  corrected: "Corrected",
};
