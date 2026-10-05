import type { Call, Lead, LeadDetail, ProjectWithKnowledge } from "./types";

// Default to 127.0.0.1, not "localhost" — avoids IPv6 (::1) resolution
// issues on Windows where the API only listens on IPv4.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  }

  const body = await res.json();
  return body.data as T;
}

export const api = {
  getProject: (id: string) => request<ProjectWithKnowledge>(`/api/projects/${id}`),
  listProjects: () => request<ProjectWithKnowledge[]>("/api/projects"),
  listLeads: () => request<Lead[]>("/api/leads"),
  getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),
  callLead: (id: string) =>
    request<{ callId: string; providerCallId: string; status: string; provider: string }>(
      `/api/leads/${id}/call`,
      { method: "POST" },
    ),
  getCall: (id: string) => request<Call & { conversation: unknown }>(`/api/calls/${id}`),
};

export { ApiError };
