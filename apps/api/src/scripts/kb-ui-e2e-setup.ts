/**
 * Seeds the DISPOSABLE database used by the knowledge-base browser e2e (apps/web/e2e/knowledge.e2e.ts).
 * Refuses any database whose name does not contain "kb_ui_test".
 *
 *   DATABASE_URL=<runtime url> DATABASE_ADMIN_URL=<owner url> tsx src/scripts/kb-ui-e2e-setup.ts
 *
 * Organizations (all users share UI_PASSWORD):
 *   KB Org      no optional modules; default "Assistant" agent   kb-owner (OWNER), kb-manager (MANAGER), kb-agent (AGENT)
 *   Other Org   owns knowledge base "Other secret base"           other-owner (OWNER)
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { adminSql, sql } from "../db/client.js";
import { hashPassword } from "../auth/password.js";
import { createOrg } from "./create-org.js";

export const UI_PASSWORD = "UiTest-Passw0rd-1";

async function main() {
  const name = new URL(process.env.DATABASE_ADMIN_URL ?? "").pathname.replace(/^\//, "");
  if (!/kb_ui_test/.test(name)) throw new Error(`Refusing to seed "${name}": database name must contain "kb_ui_test"`);
  const q = adminSql;
  if (!q) throw new Error("DATABASE_ADMIN_URL required");

  const kbOrg = await createOrg({ orgName: "KB Org", orgSlug: "kb-org", ownerEmail: "kb-owner@ui.test", ownerName: "KB Owner", ownerPassword: UI_PASSWORD, modules: [] });
  const other = await createOrg({ orgName: "Other Org", orgSlug: "other-org", ownerEmail: "other-owner@ui.test", ownerName: "Other Owner", ownerPassword: UI_PASSWORD, modules: [] });

  const hash = await hashPassword(UI_PASSWORD);
  for (const [email, role] of [
    ["kb-manager@ui.test", "MANAGER"],
    ["kb-agent@ui.test", "AGENT"],
  ] as const) {
    const [u] = await q`insert into users (email, name, password_hash) values (${email}, ${email}, ${hash}) returning id`;
    await q`insert into memberships (organization_id, user_id, role) values (${kbOrg.organizationId}, ${u.id}, ${role}::org_role)`;
  }

  const [kb] = await q`insert into knowledge_bases (organization_id, name) values (${other.organizationId}, 'Other secret base') returning id`;
  await q`insert into knowledge_items (organization_id, knowledge_base_id, kind, title, body) values (${other.organizationId}, ${kb.id}, 'faq', 'Do you deliver?', 'OTHER-ORG-SECRET')`;
  console.log(`seeded knowledge-base UI fixtures (other org knowledge base ${kb.id})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
    await adminSql?.end();
  });
