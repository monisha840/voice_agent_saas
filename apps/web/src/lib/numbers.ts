import { ApiError, apiBase } from "./api";
import type { CallStatus } from "./types";

/** Client for telephony number management (/api/numbers). */

export interface ProviderSetup {
  provider: string;
  simulated: boolean;
  configured: boolean;
  missing: string[];
  problems: string[];
  numberCheckSupported: boolean;
}

export type RoutingState = "active" | "paused" | "agent_inactive";

export interface PhoneNumberView {
  id: string;
  phoneNumber: string;
  label: string | null;
  agent: { id: string; name: string; status: string };
  routingEnabled: boolean;
  state: RoutingState;
  lastInboundAt: string | null;
  refused: { count: number; lastAt: string | null; lastReason: string | null };
  provider: { status: string | null; detail: string | null; checkedAt: string | null };
  calls: { windowDays: number; total: number; failed: number; live: number; lastCallAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface LineCall {
  id: string;
  status: CallStatus;
  callType: string;
  counterpartyNumber: string | null;
  agentId: string;
  agentName: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface PhoneNumberDetail extends PhoneNumberView {
  setup: ProviderSetup;
  recentCalls: LineCall[];
  recentFailures: LineCall[];
}

export interface CheckStep {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
}

export interface CheckResult {
  checkedAt: string;
  ok: boolean;
  steps: CheckStep[];
  number: PhoneNumberDetail;
}

export const REFUSAL_REASONS: Record<string, string> = {
  paused: "routing was paused",
  agent_inactive: "the answering agent was archived",
  CONCURRENT_CALL_LIMIT: "too many calls in progress",
  DAILY_CALL_QUOTA: "daily call limit reached",
  MONTHLY_CALL_SECONDS_QUOTA: "monthly minutes used up",
  MINUTES_EXHAUSTED: "plan minutes used up",
  SHUTTING_DOWN: "the service was restarting",
  NOT_READY: "the service was starting",
};

export const STATE_LABEL: Record<RoutingState, { text: string; tone: "success" | "warn" | "error" }> = {
  active: { text: "Answering", tone: "success" },
  paused: { text: "Paused", tone: "warn" },
  agent_inactive: { text: "Agent archived", tone: "error" },
};

export function createNumbersApi(getHeaders: () => Promise<Record<string, string>> | Record<string, string> = () => ({})) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const extra = await getHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string; code?: string };
    if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status, json.code);
    return json.data as T;
  }
  return {
    list: () => call<{ provider: ProviderSetup; numbers: PhoneNumberView[] }>("GET", "/api/numbers"),
    get: (id: string) => call<PhoneNumberDetail>("GET", `/api/numbers/${id}`),
    add: (input: { phoneNumber: string; agentId: string; label?: string | null }) => call<PhoneNumberDetail>("POST", "/api/numbers", input),
    update: (
      id: string,
      input: { label?: string | null; agentId?: string; routingEnabled?: boolean; expectedAgentId?: string; confirm?: boolean },
    ) => call<PhoneNumberDetail>("PATCH", `/api/numbers/${id}`, input),
    remove: (id: string) => call<void>("DELETE", `/api/numbers/${id}?confirm=true`),
    check: (id: string) => call<CheckResult>("POST", `/api/numbers/${id}/check`, {}),
  };
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
