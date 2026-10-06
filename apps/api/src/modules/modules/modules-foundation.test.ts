import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";

import { db } from "../../db/client.js";
import { agents, memberships, organizationModules, organizations, users } from "../../db/schema.js";
import { organizationModulesRepository } from "../../db/repositories/organization-modules.repository.js";
import { cleanupTenants, createTenant } from "../../test/tenants.js";
import { createOrg, parseModules } from "../../scripts/create-org.js";
import { DEFAULT_NEW_ORG_MODULES, MODULE_KEYS, isModuleKey } from "./module-registry.js";

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdOrgIds.length) {
    await db.delete(agents).where(inArray(agents.organizationId, createdOrgIds));
    await db.delete(organizationModules).where(inArray(organizationModules.organizationId, createdOrgIds));
    await db.delete(memberships).where(inArray(memberships.organizationId, createdOrgIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await cleanupTenants();
});

describe("module registry", () => {
  it("knows sales and defaults new organizations to it", () => {
    expect(MODULE_KEYS).toContain("sales");
    expect(DEFAULT_NEW_ORG_MODULES).toEqual(["sales"]);
    expect(isModuleKey("sales")).toBe(true);
    expect(isModuleKey("nope")).toBe(false);
  });
});

describe("organization_modules repository", () => {
  it("treats a missing row as disabled, and toggling never needs a delete", async () => {
    const t = await createTenant("ModRepo", { modules: [] });
    expect(await organizationModulesRepository.isEnabled({ organizationId: t.orgId, moduleKey: "sales" })).toBe(false);
    expect(await organizationModulesRepository.listEnabledKeys({ organizationId: t.orgId })).toEqual([]);

    await organizationModulesRepository.setEnabled({ organizationId: t.orgId, moduleKey: "sales", enabled: true });
    expect(await organizationModulesRepository.listEnabledKeys({ organizationId: t.orgId })).toEqual(["sales"]);

    await organizationModulesRepository.setEnabled({ organizationId: t.orgId, moduleKey: "sales", enabled: false });
    expect(await organizationModulesRepository.isEnabled({ organizationId: t.orgId, moduleKey: "sales" })).toBe(false);
    const rows = await organizationModulesRepository.listForOrganization({ organizationId: t.orgId });
    expect(rows).toHaveLength(1); // same row, flipped
  });
});

describe("migration 0006 backfill", () => {
  it("enables sales for pre-existing organizations, idempotently", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sqlText = readFileSync(join(dir, "../../db/migrations/0006_yummy_revanche.sql"), "utf8");
    const insert = sqlText.slice(sqlText.indexOf('INSERT INTO "organization_modules"'));
    expect(insert).toContain("ON CONFLICT");

    const legacy = await createTenant("Legacy", { modules: [] }); // an org that predates the table
    const { sql } = await import("../../db/client.js");
    await sql.unsafe(insert);
    await sql.unsafe(insert); // re-running is harmless
    const rows = await organizationModulesRepository.listForOrganization({ organizationId: legacy.orgId });
    expect(rows.map((r) => [r.moduleKey, r.enabled])).toEqual([["sales", true]]);
  });
});

describe("create-org --modules", () => {
  async function make(modules?: readonly string[]) {
    const tag = Math.random().toString(36).slice(2, 8);
    const r = await createOrg({
      orgName: `Mod Org ${tag}`,
      ownerEmail: `mod-${tag}@example.test`,
      ownerName: "Mod Owner",
      ownerPassword: "a-long-test-password",
      modules,
    });
    createdOrgIds.push(r.organizationId);
    createdUserIds.push(r.ownerUserId);
    return r;
  }

  it("enables sales by default", async () => {
    const r = await make();
    expect(await organizationModulesRepository.listEnabledKeys({ organizationId: r.organizationId })).toEqual(["sales"]);
  });

  it("can create an organization with no modules, and rejects unknown ones", async () => {
    const r = await make([]);
    expect(await organizationModulesRepository.listEnabledKeys({ organizationId: r.organizationId })).toEqual([]);
    await expect(make(["bogus"])).rejects.toThrow(/Unknown module/);
  });

  it("parses the CLI value", () => {
    expect(parseModules(undefined)).toBeUndefined();
    expect(parseModules("")).toBeUndefined();
    expect(parseModules("none")).toEqual([]);
    expect(parseModules("sales, sales")).toEqual(["sales"]);
    expect(() => parseModules("sales,xyz")).toThrow(/xyz/);
  });
});
