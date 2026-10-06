import { describe, it, expect } from "vitest";
import type { OrgRole } from "./context.js";
import { allPermissions, PERMISSION_ALIASES, canGrantRole, canManageMemberWithRole, permissionsForRole, roleHasPermission, type Permission } from "./permissions.js";

// The Sales module is registered by test/setup.ts, so the registry holds the core AND the sales permissions here (the
// matrix below is the full, unchanged product matrix; modules/sales/sales-permissions-routes.test.ts covers Sales unregistered).
const PERMISSIONS = allPermissions();

// Written out independently of permissions.ts so an accidental change to the matrix fails here.
const EXPECTED: Record<OrgRole, Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: PERMISSIONS.filter((p) => p !== "org:manage"),
  MANAGER: [
    "org:read",
    "users:read",
    "projects:read",
    "projects:update",
    "leads:read",
    "leads:create",
    "leads:update",
    "leads:assign",
    "leads:call",
    "calls:read",
    "site-visits:read",
    "site-visits:manage",
    "agents:read",
    "calls:create",
    "agent-config:read",
  ],
  AGENT: ["org:read", "projects:read", "leads:read", "leads:update", "leads:call", "calls:read", "calls:create", "site-visits:read", "site-visits:manage"],
};

const ROLES: OrgRole[] = ["OWNER", "ADMIN", "MANAGER", "AGENT"];

describe("permission matrix (4 roles x every permission)", () => {
  for (const role of ROLES) {
    describe(role, () => {
      for (const permission of PERMISSIONS) {
        const allowed = EXPECTED[role].includes(permission);
        it(`${allowed ? "allows" : "denies"} ${permission}`, () => {
          expect(roleHasPermission(role, permission)).toBe(allowed);
        });
      }
      it("permissionsForRole lists exactly the allowed set", () => {
        expect([...permissionsForRole(role)].sort()).toEqual([...EXPECTED[role]].sort());
      });
    });
  }

  it("old agent-config:* names are granted exactly like their agents:* replacements", () => {
    for (const role of ROLES) {
      for (const [oldName, newName] of Object.entries(PERMISSION_ALIASES)) {
        expect(roleHasPermission(role, oldName as Permission), `${role} ${oldName}`).toBe(roleHasPermission(role, newName));
      }
    }
  });

  it("core calls/agents permissions: everyone may place calls; managers+ read agents; admins+ manage them", () => {
    expect(ROLES.filter((r) => roleHasPermission(r, "calls:create"))).toEqual(ROLES);
    expect(ROLES.filter((r) => roleHasPermission(r, "agents:read"))).toEqual(["OWNER", "ADMIN", "MANAGER"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "agents:manage"))).toEqual(["OWNER", "ADMIN"]);
  });

  it("only OWNER manages the organization; only OWNER/ADMIN manage the team", () => {
    expect(ROLES.filter((r) => roleHasPermission(r, "org:manage"))).toEqual(["OWNER"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "users:manage"))).toEqual(["OWNER", "ADMIN"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "users:invite"))).toEqual(["OWNER", "ADMIN"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "audit:read"))).toEqual(["OWNER", "ADMIN"]);
  });

  it("every lower role's permissions are a subset of the role above", () => {
    for (let i = 1; i < ROLES.length; i++) {
      for (const p of EXPECTED[ROLES[i]]) expect(roleHasPermission(ROLES[i - 1], p)).toBe(true);
    }
  });
});

describe("role hierarchy", () => {
  const grant: Record<OrgRole, Record<OrgRole, boolean>> = {
    OWNER: { OWNER: true, ADMIN: true, MANAGER: true, AGENT: true },
    ADMIN: { OWNER: false, ADMIN: false, MANAGER: true, AGENT: true },
    MANAGER: { OWNER: false, ADMIN: false, MANAGER: false, AGENT: true },
    AGENT: { OWNER: false, ADMIN: false, MANAGER: false, AGENT: false },
  };
  const manage: Record<OrgRole, Record<OrgRole, boolean>> = {
    OWNER: { OWNER: true, ADMIN: true, MANAGER: true, AGENT: true },
    ADMIN: { OWNER: false, ADMIN: false, MANAGER: true, AGENT: true },
    MANAGER: { OWNER: false, ADMIN: false, MANAGER: false, AGENT: true },
    AGENT: { OWNER: false, ADMIN: false, MANAGER: false, AGENT: false },
  };

  for (const actor of ROLES) {
    for (const target of ROLES) {
      it(`canGrantRole(${actor}, ${target}) = ${grant[actor][target]}`, () => {
        expect(canGrantRole(actor, target)).toBe(grant[actor][target]);
      });
      it(`canManageMemberWithRole(${actor}, ${target}) = ${manage[actor][target]}`, () => {
        expect(canManageMemberWithRole(actor, target)).toBe(manage[actor][target]);
      });
    }
  }
});
