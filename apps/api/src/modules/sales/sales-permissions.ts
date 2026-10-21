/**
 * The permissions the Sales module contributes. The core permission matrix lists none of these: they exist only
 * while the Sales module is registered, and are only usable in organizations that have it enabled.
 *
 * OWNER and ADMIN always hold every module permission; the lists below are the roles under ADMIN that get each one.
 */
import type { ModulePermissionSet, SubAdminRole } from "../../auth/permissions.js";
import { SALES_MODULE_KEY } from "./sales-constants.js";

// Tell the type system these names are valid `Permission`s (so assertCan(ctx, "leads:read") stays type-checked)
// without the core ever listing them.
declare module "../../auth/permissions.js" {
  interface ModulePermissions {
    "projects:read": true;
    "projects:create": true;
    "projects:update": true;
    "projects:archive": true;
    "projects:members": true;
    "leads:read": true;
    "leads:create": true;
    "leads:update": true;
    "leads:assign": true;
    "leads:call": true;
    "site-visits:read": true;
    "site-visits:manage": true;
  }
}

const MANAGER_AND_AGENT: readonly SubAdminRole[] = ["MANAGER", "AGENT"];
const MANAGER_ONLY: readonly SubAdminRole[] = ["MANAGER"];
const OWNER_ADMIN_ONLY: readonly SubAdminRole[] = [];

export const SALES_PERMISSIONS: ModulePermissionSet = {
  module: SALES_MODULE_KEY,
  grants: {
    "projects:read": MANAGER_AND_AGENT,
    "projects:create": OWNER_ADMIN_ONLY,
    "projects:update": MANAGER_ONLY,
    "projects:archive": OWNER_ADMIN_ONLY,
    "projects:members": OWNER_ADMIN_ONLY,
    "leads:read": MANAGER_AND_AGENT,
    "leads:create": MANAGER_ONLY,
    "leads:update": MANAGER_AND_AGENT,
    "leads:assign": MANAGER_ONLY,
    "leads:call": MANAGER_AND_AGENT,
    "site-visits:read": MANAGER_AND_AGENT,
    "site-visits:manage": MANAGER_AND_AGENT,
  },
};
