import type { AuthOrganization } from "./api";

/**
 * Optional feature packs. The Voice AI core is always available; a module is
 * available only when the active organization has it enabled (the API reports
 * this on /api/auth/me and enforces it on every module route).
 */
export type ModuleKey = "sales";

export function hasModule(org: Pick<AuthOrganization, "modules"> | null | undefined, key: ModuleKey): boolean {
  return org?.modules?.includes(key) ?? false;
}

/**
 * Fired on `window` after the organization's modules change. The navigation is a client component that
 * loads /api/auth/me once, and router.refresh() does not remount it, so it listens for this to reload.
 */
export const ORG_MODULES_CHANGED_EVENT = "va:org-modules-changed";
