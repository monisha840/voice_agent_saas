/**
 * Creates a customer organization with its first OWNER. Sign-up is
 * invite-only, so this is how the very first org of a real customer exists.
 *
 *   ORG_NAME="Acme Realty" OWNER_EMAIL=boss@acme.test OWNER_NAME="A Boss" \
 *   OWNER_PASSWORD='...' pnpm org:create
 *
 * Optional: ORG_SLUG (derived from the name otherwise). MODULES (or `--modules a,b`) lists the
 * optional modules to enable, e.g. MODULES=sales; "none" enables none. Default: sales. If a user with
 * OWNER_EMAIL already exists they are attached as OWNER and their password is
 * left untouched (OWNER_PASSWORD is then not needed). The password is never printed.
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { pathToFileURL } from "node:url";
import { adminSql, db, sql } from "../db/client.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { agents, memberships, organizationModules, organizations, users } from "../db/schema.js";
import { GENERIC_TOOL_NAMES } from "../modules/agents/agents.constants.js";
import { DEFAULT_SALES_CONFIG, SALES_TOOL_NAMES } from "../modules/sales/sales-constants.js";
import { DEFAULT_NEW_ORG_MODULES, MODULE_KEYS, isModuleKey, type ModuleKey } from "../modules/modules/module-registry.js";
import { hashPassword } from "../auth/password.js";
import { organizationsRepository } from "../db/repositories/organizations.repository.js";
import { usersRepository } from "../db/repositories/users.repository.js";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface CreateOrgInput {
  orgName: string;
  orgSlug?: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;
  /** Optional modules to enable. Omitted = the current default (sales); [] = none. */
  modules?: readonly string[];
}

/** Parses "sales,foo" / "none" / "" (= default) from the CLI flag or MODULES env var. */
export function parseModules(raw: string | undefined): ModuleKey[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.trim().toLowerCase() === "none") return [];
  const keys = raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  const unknown = keys.filter((k) => !isModuleKey(k));
  if (unknown.length > 0) throw new Error(`Unknown module(s): ${unknown.join(", ")}. Available: ${MODULE_KEYS.join(", ")}`);
  return [...new Set(keys as ModuleKey[])];
}

export async function createOrg(input: CreateOrgInput) {
  const name = input.orgName.trim();
  if (!name) throw new Error("ORG_NAME is required");
  const slug = (input.orgSlug?.trim() || slugify(name)).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) {
    throw new Error("ORG_SLUG must be 1-60 chars of lowercase letters, digits and hyphens");
  }
  const email = input.ownerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("OWNER_EMAIL is required and must be a valid email");

  if (await organizationsRepository.findBySlug({ slug })) {
    throw new Error(`An organization with slug "${slug}" already exists`);
  }

  const modules = input.modules ?? DEFAULT_NEW_ORG_MODULES;
  const badModule = modules.find((k) => !isModuleKey(k));
  if (badModule) throw new Error(`Unknown module "${badModule}". Available: ${MODULE_KEYS.join(", ")}`);

  const existing = await usersRepository.findByEmail({ email });
  let passwordHash: string | null = null;
  if (!existing) {
    if (!input.ownerName.trim()) throw new Error("OWNER_NAME is required for a new owner");
    const pw = input.ownerPassword ?? "";
    if (pw.length < 10 || pw.length > 128) throw new Error("OWNER_PASSWORD is required for a new owner (10-128 characters)");
    passwordHash = await hashPassword(pw);
  }

  // One transaction: no half-created organization if anything fails.
  // Provisioning an organization is an administrative act (the runtime role cannot create organizations).
  return runAsAdmin(() => db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name, slug }).returning();
    let userId = existing?.id;
    if (!userId) {
      const [user] = await tx
        .insert(users)
        .values({ email, name: input.ownerName.trim(), passwordHash: passwordHash! })
        .returning();
      userId = user.id;
    }
    await tx.insert(memberships).values({ organizationId: org.id, userId, role: "OWNER" });
    for (const moduleKey of modules) {
      await tx.insert(organizationModules).values({ organizationId: org.id, moduleKey, enabled: true });
    }
    // Every organization starts with a generic default agent; Sales organizations also get a sales agent.
    await tx.insert(agents).values({
      organizationId: org.id,
      name: "Assistant",
      personaName: "Assistant",
      promptTemplateKey: "generic",
      enabledTools: [...GENERIC_TOOL_NAMES],
      isDefault: true,
      createdByUserId: userId,
      updatedByUserId: userId,
    });
    if ((modules as readonly string[]).includes("sales")) {
      await tx.insert(agents).values({
        organizationId: org.id,
        name: "Sales assistant",
        personaName: "Priya",
        companyName: name.slice(0, 160),
        promptTemplateKey: "sales_real_estate",
        enabledTools: [...SALES_TOOL_NAMES],
        moduleConfig: { sales: { ...DEFAULT_SALES_CONFIG } },
        isDefault: false,
        createdByUserId: userId,
        updatedByUserId: userId,
      });
    }
    return {
      modules: [...modules], organizationId: org.id, slug, ownerUserId: userId, ownerEmail: email, ownerWasExisting: Boolean(existing) };
  }));
}

function cliModulesArg(): string | undefined {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith("--modules="));
  if (eq) return eq.slice("--modules=".length);
  const i = args.indexOf("--modules");
  return i >= 0 ? args[i + 1] ?? "" : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createOrg({
    orgName: process.env.ORG_NAME ?? "",
    orgSlug: process.env.ORG_SLUG,
    ownerEmail: process.env.OWNER_EMAIL ?? "",
    ownerName: process.env.OWNER_NAME ?? "",
    ownerPassword: process.env.OWNER_PASSWORD,
    modules: parseModules(cliModulesArg() ?? process.env.MODULES),
  })
    .then((r) => {
      console.log(`Created organization "${r.slug}" (${r.organizationId}). Modules: ${r.modules.join(", ") || "none"}.`);
      console.log(
        r.ownerWasExisting
          ? `Existing user ${r.ownerEmail} is now its OWNER (password unchanged).`
          : `Owner ${r.ownerEmail} created. They can sign in with the password you provided.`,
      );
    })
    .catch((err) => {
      console.error(`org:create failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
      await adminSql?.end();
    });
}
