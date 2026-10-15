/**
 * Seeds the DISPOSABLE database used by the browser e2e of the account-security UI (apps/web/e2e).
 * Refuses any database whose name does not contain "ui_test".
 *
 *   DATABASE_URL=<runtime url> DATABASE_ADMIN_URL=<owner url> tsx src/scripts/ui-e2e-setup.ts
 *
 * Creates org "UI Test Org" with OWNER owner@ui.test and an ADMIN admin@ui.test (same password), then prints nothing secret.
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { adminSql, sql } from "../db/client.js";
import { createOrg } from "./create-org.js";

export const UI_PASSWORD = "UiTest-Passw0rd-1";

async function main() {
  const name = new URL(process.env.DATABASE_ADMIN_URL ?? "").pathname.replace(/^\//, "");
  if (!/ui_test/.test(name)) throw new Error(`Refusing to seed "${name}": database name must contain "ui_test"`);
  if (!adminSql) throw new Error("DATABASE_ADMIN_URL required");
  await createOrg({ orgName: "UI Test Org", orgSlug: "ui-test-org", ownerEmail: "owner@ui.test", ownerName: "UI Owner", ownerPassword: UI_PASSWORD });
  const r = await createOrg({ orgName: "UI Admin Org", orgSlug: "ui-admin-org", ownerEmail: "admin@ui.test", ownerName: "UI Admin", ownerPassword: UI_PASSWORD });
  await adminSql`update memberships set role = 'ADMIN' where user_id = ${r.ownerUserId}`;
  console.log("seeded owner@ui.test (OWNER) and admin@ui.test (ADMIN)");
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
