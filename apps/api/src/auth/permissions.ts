/**
 * The permission matrix. Pure data + pure functions: no database, no HTTP.
 * Authorization is enforced in the SERVICE layer (see auth/access.ts), so it
 * holds for every caller — routes today, anything else tomorrow — and never
 * depends on what the UI chooses to show.
 *
 * Roles (highest to lowest):
 *   OWNER    everything, including organization settings and other owners
 *   ADMIN    everything except organization settings (team, agents, usage, every module's features)
 *   MANAGER  reads agents and the team, places and reviews calls, plus whatever modules grant managers
 *   AGENT    places and reviews its own calls, plus whatever modules grant agents
 *
 * This file knows ONLY the Voice AI core's permissions. An optional module (Sales, ...) contributes its own with
 * registerPermissions() when it is plugged in (modules/modules/module-runtime.ts), and declares their names to the
 * type system by augmenting `ModulePermissions` (see modules/sales/sales-permissions.ts). With the module not
 * registered its permissions do not exist: nobody holds them, not even an OWNER.
 *
 * Whether a MANAGER/AGENT may touch a particular record is a second, data-level check ("scope", auth/access.ts)
 * layered on top of these permissions.
 */
import type { OrgRole } from "./context.js";

/** Permissions of the Voice AI core. "agent-config:*" are the previous names of "agents:*" (aliases, below). */
export const CORE_PERMISSIONS = [
  "org:read",
  "org:manage",
  "users:read",
  "users:invite",
  "users:manage",
  "calls:read",
  "calls:create",
  "agents:read",
  "agents:manage",
  "agent-config:read",
  "agent-config:manage",
  "audit:read",
  "usage:read",
] as const;

export type CorePermission = (typeof CORE_PERMISSIONS)[number];

/**
 * Names of the permissions modules contribute. Empty here on purpose: a module adds its names by declaration merging
 *   declare module "../../auth/permissions.js" { interface ModulePermissions { "leads:read": true } }
 * so call sites stay type-checked while the core never lists a module's permission.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ModulePermissions {}

export type Permission = CorePermission | keyof ModulePermissions;

/** The roles below ADMIN. OWNER and ADMIN hold every registered permission (ADMIN: except "org:manage"). */
export type SubAdminRole = Extract<OrgRole, "MANAGER" | "AGENT">;

/** Which sub-admin roles hold each core permission (everything not listed here is OWNER/ADMIN only). */
const CORE_GRANTS: Readonly<Partial<Record<CorePermission, readonly SubAdminRole[]>>> = {
  "org:read": ["MANAGER", "AGENT"],
  "users:read": ["MANAGER"],
  "calls:read": ["MANAGER", "AGENT"],
  "calls:create": ["MANAGER", "AGENT"],
  "agents:read": ["MANAGER"],
};

/**
 * Temporary aliases (one phase): the old permission name is granted exactly when the new one is.
 * Remove together with the old names once callers have moved to "agents:*".
 */
export const PERMISSION_ALIASES: Readonly<Record<string, Permission>> = {
  "agent-config:read": "agents:read",
  "agent-config:manage": "agents:manage",
};

/** What one module contributes: its permissions, and which sub-admin roles get each. */
export interface ModulePermissionSet {
  /** The module's key (matches its manifest and the module catalogue). */
  module: string;
  grants: Readonly<Record<string, readonly SubAdminRole[]>>;
}

const modulePermissions = new Map<string, ModulePermissionSet>();
const moduleOfName = new Map<string, string>();

const isCore = (name: string): name is CorePermission => (CORE_PERMISSIONS as readonly string[]).includes(name);

/**
 * Adds a module's permissions. Idempotent per module (registering again replaces its set). A module can never
 * redefine a core permission or take one that another module already owns.
 */
export function registerPermissions(set: ModulePermissionSet): void {
  for (const name of Object.keys(set.grants)) {
    if (isCore(name)) throw new Error(`Module "${set.module}" cannot redefine the core permission "${name}"`);
    const owner = moduleOfName.get(name);
    if (owner && owner !== set.module) throw new Error(`Permission "${name}" is already provided by module "${owner}"`);
  }
  unregisterPermissions(set.module);
  modulePermissions.set(set.module, set);
  for (const name of Object.keys(set.grants)) moduleOfName.set(name, set.module);
}

/** Removes everything a module added; its permissions stop existing. */
export function unregisterPermissions(module: string): void {
  const set = modulePermissions.get(module);
  if (!set) return;
  for (const name of Object.keys(set.grants)) moduleOfName.delete(name);
  modulePermissions.delete(module);
}

/** The module that provides a permission, or null for a core (or unknown) permission. */
export function moduleOfPermission(permission: string): string | null {
  return moduleOfName.get(permission) ?? null;
}

/** Every permission that currently exists: the core's plus those of the registered modules. */
export function allPermissions(): Permission[] {
  return [...CORE_PERMISSIONS, ...moduleOfName.keys()] as Permission[];
}

function subAdminGrants(permission: string): readonly SubAdminRole[] | undefined {
  if (isCore(permission)) return CORE_GRANTS[permission];
  const module = moduleOfName.get(permission);
  return module ? modulePermissions.get(module)?.grants[permission] : undefined;
}

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  const name = PERMISSION_ALIASES[permission] ?? permission;
  const exists = isCore(name) || moduleOfName.has(name);
  if (!exists) return false;
  if (role === "OWNER") return true;
  if (role === "ADMIN") return name !== "org:manage";
  return subAdminGrants(name)?.includes(role) ?? false;
}

export function permissionsForRole(role: OrgRole): Permission[] {
  return allPermissions().filter((p) => roleHasPermission(role, p));
}

/** Higher number = more authority. */
const RANK: Record<OrgRole, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, AGENT: 1 };

/**
 * Team-management rules: you can only grant or change roles BELOW your own,
 * except that OWNERs may also create other OWNERs. (An ADMIN can manage
 * managers and agents; only an OWNER can touch admins or owners.)
 */
export function canGrantRole(actor: OrgRole, target: OrgRole): boolean {
  if (actor === "OWNER") return true;
  return RANK[target] < RANK[actor];
}

/** May `actor` change or remove an existing member who currently holds `current`? */
export function canManageMemberWithRole(actor: OrgRole, current: OrgRole): boolean {
  if (actor === "OWNER") return true;
  return RANK[current] < RANK[actor];
}
