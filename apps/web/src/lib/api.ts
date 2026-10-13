import type {
  Agent,
  AgentPhoneNumber,
  AgentOption,
  AgentInput,
  CallDetail,
  CallType,
  SiteVisitRow,
  ToolInfo,
  AgentConfig,
  AgentConfigResponse,
  AuditLog,
  Conversation,
  Call,
  CallListItem,
  CallStatus,
  FollowUp,
  FollowUpQueueItem,
  Invitation,
  KnowledgeCategory,
  Lead,
  LeadDetail,
  LeadInput,
  OrganizationModule,
  Project,
  ProjectMember,
  ProjectWithKnowledge,
  Role,
  TeamMember,
  UsageSummary,
} from "./types";

// Default to 127.0.0.1, not "localhost" — avoids IPv6 (::1) resolution
// issues on Windows where the API only listens on IPv4. Open the dashboard on
// the same host (http://127.0.0.1:3000) so the session cookie is sent to both.
const CONFIGURED_API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
export const API_BASE = CONFIGURED_API_BASE;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where to send API requests. In the browser, when both the page and the
 * configured API are on this machine, use the SAME host the page was opened on:
 * the session cookie is host-scoped and SameSite=Lax, so a page on localhost:3000
 * calling 127.0.0.1:4000 is cross-site and the browser silently drops the cookie
 * (login "succeeds" but the next page is logged out). On the Next server there is
 * no browser, so the configured URL is used as-is.
 */
export function apiBase(): string {
  if (typeof window === "undefined") return CONFIGURED_API_BASE;
  try {
    const url = new URL(CONFIGURED_API_BASE);
    if (LOOPBACK.has(url.hostname) && LOOPBACK.has(window.location.hostname)) {
      url.hostname = window.location.hostname;
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // fall through to the configured value
  }
  return CONFIGURED_API_BASE;
}

class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  /** Enabled optional modules (e.g. "sales"); only present on the ACTIVE organization from /auth/me. */
  modules?: string[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** The organization this session is working in (null if the user has none). */
  organization?: AuthOrganization | null;
  organizations?: AuthOrganization[];
}

/** Extra request headers, e.g. the session cookie when rendering on the Next server. */
type HeaderProvider = () => Promise<Record<string, string>> | Record<string, string>;

/**
 * Builds the API client. In the browser the session cookie is attached by
 * `credentials: "include"`; on the Next server (server components) there is no
 * browser, so lib/api.server.ts supplies the incoming request's cookie header.
 */
export function createApi(getExtraHeaders: HeaderProvider = () => ({})) {
  async function raw(path: string, init?: RequestInit): Promise<any> {
    const extra = await getExtraHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      // Fastify rejects a JSON content-type with an empty body (e.g. demo-login), so only set it when sending one.
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...extra, ...init?.headers },
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
    }
    // 204 No Content (e.g. deleting a knowledge category) has no body to parse.
    if (res.status === 204) return {};
    return res.json();
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const body = await raw(path, init);
    return body.data as T;
  }

  const send = <T>(method: string, path: string, body?: unknown) =>
    request<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return {
    getProject: (id: string) => request<ProjectWithKnowledge>(`/api/projects/${id}`),
    listProjects: () => request<ProjectWithKnowledge[]>("/api/projects"),
    listLeads: () => request<Lead[]>("/api/leads"),
    getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),
    callLead: (id: string, agentId?: string) =>
      request<{ callId: string; providerCallId: string; status: string; provider: string }>(
        `/api/leads/${id}/call`,
        agentId ? { method: "POST", body: JSON.stringify({ agentId }) } : { method: "POST" },
      ),
    getCall: (id: string) => request<CallDetail>(`/api/calls/${id}`),
    createCall: (input: { agentId: string; callType: "outbound" | "test"; toNumber?: string; leadId?: string }) =>
      send<{ callId: string; providerCallId: string; status: string; provider: string; callType: CallType }>(
        "POST",
        "/api/calls",
        input,
      ),
    /** Browser web call: creates the call record; the audio then goes over the WebSocket at /api/web-call/stream. */
    createWebCall: (input: { agentId?: string; leadId?: string }) =>
      send<{ callId: string; agentId: string; sampleRate: number }>("POST", "/api/calls/web", input),
    listSiteVisits: () => request<SiteVisitRow[]>("/api/site-visits"),
    /** Open follow-ups the agent noted for the team (human requested, callback, info requested, do not call). */
    listFollowUps: () => request<FollowUpQueueItem[]>("/api/follow-ups"),
    completeFollowUp: (id: string) => send<FollowUp>("POST", `/api/follow-ups/${id}/done`),

    // --- agents ---
    listAgents: (includeArchived = false) =>
      request<Agent[]>(`/api/agents${qs({ includeArchived: includeArchived || undefined })}`),
    /** Active agents to choose from (id, name, persona, status only): allowed for every role that can place calls. */
    listAgentOptions: () => request<AgentOption[]>("/api/agent-options"),
    getAgent: (id: string) => request<Agent>(`/api/agents/${id}`),
    createAgent: (input: AgentInput) => send<Agent>("POST", "/api/agents", input),
    updateAgent: (id: string, input: AgentInput) => send<Agent>("PATCH", `/api/agents/${id}`, input),
    archiveAgent: (id: string) => send<Agent>("POST", `/api/agents/${id}/archive`),
    unarchiveAgent: (id: string) => send<Agent>("POST", `/api/agents/${id}/unarchive`),
    setDefaultAgent: (id: string) => send<Agent>("POST", `/api/agents/${id}/set-default`),
    setAgentKnowledge: (id: string, projectIds: string[]) =>
      send<Agent>("PUT", `/api/agents/${id}/knowledge`, {
        bindings: projectIds.map((sourceId) => ({ sourceType: "project", sourceId })),
      }),
    listAgentPhoneNumbers: (id: string) => request<AgentPhoneNumber[]>(`/api/agents/${id}/phone-numbers`),
    addAgentPhoneNumber: (id: string, input: { phoneNumber: string; label?: string | null }) =>
      send<AgentPhoneNumber>("POST", `/api/agents/${id}/phone-numbers`, input),
    removeAgentPhoneNumber: (id: string, numberId: string) =>
      send<unknown>("DELETE", `/api/agents/${id}/phone-numbers/${numberId}`),
    listTools: () => request<ToolInfo[]>("/api/tools"),
    // The calls list returns top-level data + nextBefore, so it bypasses the data-unwrapping helper.
    listCalls: async (opts: {
        limit?: number;
        before?: string | null;
        status?: CallStatus | "";
        agentId?: string;
        callType?: CallType | "";
      } = {},
    ) => {
      const body = await raw(
        `/api/calls${qs({
          limit: opts.limit,
          before: opts.before,
          status: opts.status,
          agentId: opts.agentId,
          callType: opts.callType,
        })}`,
      );
      return { data: (body.data ?? []) as CallListItem[], nextBefore: (body.nextBefore ?? null) as string | null };
    },

    // --- auth ---
    authConfig: () => request<{ demoLoginEnabled: boolean }>("/api/auth/config"),
    login: (email: string, password: string) =>
      request<AuthUser>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    demoLogin: () => request<AuthUser>("/api/auth/demo-login", { method: "POST" }),
    logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    me: () => request<AuthUser>("/api/auth/me"),
    switchOrganization: (organizationId: string) =>
      send<unknown>("POST", "/api/auth/switch-organization", { organizationId }),
    acceptInvite: (token: string, name: string, password: string) =>
      send<AuthUser>("POST", "/api/auth/accept-invite", { token, name, password }),

    // --- organization ---
    getOrganization: () => request<{ id: string; name: string }>("/api/organization"),
    renameOrganization: (name: string) => send<{ id: string; name: string }>("PATCH", "/api/organization", { name }),

    // --- modules ---
    listModules: () => request<OrganizationModule[]>("/api/organization/modules"),
    setModuleEnabled: (key: string, enabled: boolean) =>
      send<OrganizationModule>("PUT", `/api/organization/modules/${key}`, { enabled }),

    // --- projects ---
    listProjectsAll: (includeArchived = false) =>
      request<Project[]>(`/api/projects${qs({ includeArchived: includeArchived || undefined })}`),
    createProject: (input: { name: string; location: string; description?: string }) =>
      send<Project>("POST", "/api/projects", input),
    updateProject: (id: string, input: { name?: string; location?: string; description?: string }) =>
      send<Project>("PATCH", `/api/projects/${id}`, input),
    archiveProject: (id: string) => send<Project>("POST", `/api/projects/${id}/archive`),
    unarchiveProject: (id: string) => send<Project>("POST", `/api/projects/${id}/unarchive`),
    saveKnowledge: (id: string, category: KnowledgeCategory, content: unknown) =>
      send<unknown>("PUT", `/api/projects/${id}/knowledge/${category}`, { content }),
    deleteKnowledge: (id: string, category: KnowledgeCategory) =>
      send<unknown>("DELETE", `/api/projects/${id}/knowledge/${category}`),
    listProjectMembers: (id: string) => request<ProjectMember[]>(`/api/projects/${id}/members`),
    setProjectMembers: (id: string, userIds: string[]) =>
      send<unknown>("PUT", `/api/projects/${id}/members`, { userIds }),

    // --- agent config ---
    getAgentConfig: (projectId?: string) =>
      request<AgentConfigResponse>(`/api/agent-config${qs({ projectId })}`),
    saveAgentConfig: (config: AgentConfig, projectId?: string) =>
      send<unknown>("PUT", "/api/agent-config", { ...(projectId ? { projectId } : {}), ...config }),
    resetAgentConfig: (projectId?: string) =>
      send<unknown>("DELETE", `/api/agent-config${qs({ projectId })}`),

    // --- team ---
    listUsers: () => request<TeamMember[]>("/api/users"),
    inviteUser: (email: string, role: Role) =>
      send<{ invitation: Invitation; inviteToken: string; acceptPath: string }>("POST", "/api/users/invitations", {
        email,
        role,
      }),
    listInvitations: () => request<Invitation[]>("/api/users/invitations"),
    revokeInvitation: (id: string) => send<unknown>("DELETE", `/api/users/invitations/${id}`),
    changeRole: (userId: string, role: Role) => send<unknown>("PATCH", `/api/users/${userId}/role`, { role }),
    removeUser: (userId: string) => send<unknown>("DELETE", `/api/users/${userId}`),

    // --- leads ---
    createLead: (input: LeadInput) => send<Lead>("POST", "/api/leads", input),
    updateLead: (id: string, input: Partial<LeadInput>) => send<Lead>("PATCH", `/api/leads/${id}`, input),
    assignLead: (id: string, userId: string | null) => send<Lead>("POST", `/api/leads/${id}/assign`, { userId }),

    // --- audit / usage (admin) ---
    // Audit returns top-level data + nextBefore, so it bypasses the data-unwrapping helper.
    listAuditLogs: async (opts: { limit?: number; before?: string | null } = {}) => {
      const body = await raw(`/api/audit-logs${qs({ limit: opts.limit, before: opts.before })}`);
      return { data: (body.data ?? []) as AuditLog[], nextBefore: (body.nextBefore ?? null) as string | null };
    },
    usageSummary: (from?: string, to?: string) => request<UsageSummary>(`/api/usage/summary${qs({ from, to })}`),
  };
}

/** Browser-side client (client components). */
export const api = createApi();

export { ApiError };
