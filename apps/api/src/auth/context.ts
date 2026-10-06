/**
 * The request context: WHO is acting and in WHICH organization. Every
 * service that touches tenant data takes one as its first argument, and
 * passes its organizationId to every repository query. That makes tenant
 * isolation a property of the data-access layer (a query without an
 * organization simply does not compile), not something each route must
 * remember — and never something only the frontend filters.
 *
 * Two kinds of actor:
 *  - user:   a logged-in person; carries their role in this organization
 *  - system: background/automated work with no login — the Exotel webhook,
 *            the media-stream socket, AI tool calls, the stale-call reaper.
 *            A system context is always derived from a record that already
 *            belongs to an organization (e.g. a call), never from input.
 */
export type OrgRole = "OWNER" | "ADMIN" | "MANAGER" | "AGENT";

export type SystemSource =
  | "exotel-webhook"
  | "media-stream"
  | "ai-tool"
  | "reaper"
  | "seed"
  | "simulator"
  | "telephony-inbound"
  | "test";

export interface UserActor {
  type: "user";
  userId: string;
  role: OrgRole;
}

export interface SystemActor {
  type: "system";
  source: SystemSource;
}

export interface RequestContext {
  organizationId: string;
  actor: UserActor | SystemActor;
  /**
   * Keys of the optional modules this organization has enabled, as loaded for a logged-in request. When present, a
   * permission that belongs to a module is only usable if that module is listed here (auth/access.ts). Absent means
   * "not loaded" (system flows, direct service calls): only the role is checked, exactly as before modules existed.
   */
  enabledModules?: readonly string[];
}

export function systemContext(organizationId: string, source: SystemSource): RequestContext {
  return { organizationId, actor: { type: "system", source } };
}

export function userContext(organizationId: string, userId: string, role: OrgRole, enabledModules?: readonly string[]): RequestContext {
  return { organizationId, actor: { type: "user", userId, role }, ...(enabledModules ? { enabledModules } : {}) };
}
