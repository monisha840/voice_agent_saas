import type { Role } from "./types";

/**
 * Client-side mirror of the API permission matrix. Used ONLY to show or hide
 * controls; the backend enforces every rule regardless.
 */
export type Action =
  | "org:manage"
  | "users:read"
  | "users:manage"
  | "projects:create"
  | "projects:update"
  | "projects:archive"
  | "projects:members"
  | "leads:create"
  | "leads:update"
  | "leads:assign"
  | "agents:read"
  | "agents:manage"
  | "calls:create"
  | "agent-config:read"
  | "agent-config:manage"
  | "audit:read"
  | "usage:read"
  | "calls:read";

const RANK: Record<Role, number> = { AGENT: 0, MANAGER: 1, ADMIN: 2, OWNER: 3 };

const MIN_ROLE: Record<Action, Role> = {
  "org:manage": "OWNER",
  "users:read": "MANAGER",
  "users:manage": "ADMIN",
  "projects:create": "ADMIN",
  "projects:update": "MANAGER", // managers: only projects they belong to (API enforces membership)
  "projects:archive": "ADMIN",
  "projects:members": "ADMIN",
  "leads:create": "MANAGER",
  "leads:update": "MANAGER",
  "leads:assign": "MANAGER",
  "agents:read": "MANAGER",
  "agents:manage": "ADMIN",
  "calls:create": "AGENT",
  "agent-config:read": "MANAGER",
  "agent-config:manage": "ADMIN",
  "audit:read": "ADMIN",
  "usage:read": "ADMIN",
  "calls:read": "AGENT", // agents only see calls on their own leads (API enforces scope)
};

export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[MIN_ROLE[action]];
}

/** Roles the caller may grant or revoke: ADMIN cannot touch OWNER/ADMIN. */
export function grantableRoles(role: Role | null | undefined): Role[] {
  if (role === "OWNER") return ["OWNER", "ADMIN", "MANAGER", "AGENT"];
  if (role === "ADMIN") return ["MANAGER", "AGENT"];
  return [];
}

/** Can the caller change or remove a member who currently holds `target`? */
export function canManageMember(role: Role | null | undefined, target: Role): boolean {
  return grantableRoles(role).includes(target);
}
