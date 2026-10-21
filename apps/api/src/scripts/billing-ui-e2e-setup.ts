/**
 * Seeds the DISPOSABLE database used by the billing browser e2e (apps/web/e2e/billing.e2e.ts).
 * Refuses any database whose name does not contain "billing_ui_test".
 *
 *   DATABASE_URL=<runtime url> DATABASE_ADMIN_URL=<owner url> tsx src/scripts/billing-ui-e2e-setup.ts
 *
 * Organizations (all users share UI_PASSWORD):
 *   Legacy Org     unmanaged (no subscription)            legacy-owner@ui.test (OWNER)
 *   Managed Org    starter plan, 25 ended calls           m-owner / m-admin / m-manager / m-agent @ui.test
 *   Exhausted Org  trial with all 30 minutes used         x-owner@ui.test
 *   Empty Org      trial, no calls                        e-owner@ui.test
 *   multi@ui.test  OWNER of Legacy Org and AGENT of Managed Org (organization switching)
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { adminSql, sql } from "../db/client.js";
import { hashPassword } from "../auth/password.js";
import { createOrg } from "./create-org.js";

export const UI_PASSWORD = "UiTest-Passw0rd-1";

async function main() {
  const name = new URL(process.env.DATABASE_ADMIN_URL ?? "").pathname.replace(/^\//, "");
  if (!/billing_ui_test/.test(name)) throw new Error(`Refusing to seed "${name}": database name must contain "billing_ui_test"`);
  const q = adminSql;
  if (!q) throw new Error("DATABASE_ADMIN_URL required");

  const mk = (orgName: string, slug: string, email: string) =>
    createOrg({ orgName, orgSlug: slug, ownerEmail: email, ownerName: orgName, ownerPassword: UI_PASSWORD, modules: [] });
  const legacy = await mk("Legacy Org", "legacy-org", "legacy-owner@ui.test");
  const managed = await mk("Managed Org", "managed-org", "m-owner@ui.test");
  const exhausted = await mk("Exhausted Org", "exhausted-org", "x-owner@ui.test");
  const empty = await mk("Empty Org", "empty-org", "e-owner@ui.test");

  const hash = await hashPassword(UI_PASSWORD);
  const addMember = async (orgId: string, email: string, role: string) => {
    const [u] = await q`insert into users (email, name, password_hash) values (${email}, ${email}, ${hash})
                        on conflict (email) do update set email = excluded.email returning id`;
    await q`insert into memberships (organization_id, user_id, role) values (${orgId}, ${u.id}, ${role}::org_role)`;
  };
  await addMember(managed.organizationId, "m-admin@ui.test", "ADMIN");
  await addMember(managed.organizationId, "m-manager@ui.test", "MANAGER");
  await addMember(managed.organizationId, "m-agent@ui.test", "AGENT");
  await addMember(legacy.organizationId, "multi@ui.test", "OWNER");
  await addMember(managed.organizationId, "multi@ui.test", "AGENT");

  const agentOf = async (orgId: string) => (await q`select id from agents where organization_id = ${orgId} limit 1`)[0].id as string;
  const addCalls = async (orgId: string, seconds: number[]) => {
    const agentId = await agentOf(orgId);
    for (const s of seconds) {
      const started = new Date(Date.now() - 60_000);
      await q`insert into calls (organization_id, agent_id, status, call_type, started_at, ended_at)
              values (${orgId}, ${agentId}, 'completed', 'outbound', ${started.toISOString()}::timestamptz, ${new Date(started.getTime() + s * 1000).toISOString()}::timestamptz)`;
    }
  };
  const subscribe = (orgId: string, plan: string, status: string, trialDays: number | null, overrides = "{}") =>
    q`insert into subscriptions (organization_id, plan_key, status, trial_ends_at, current_period_start, current_period_end, limit_overrides)
      values (${orgId}, ${plan}, ${status}::subscription_status,
              ${trialDays ? new Date(Date.now() + trialDays * 86_400_000).toISOString() : null}::timestamptz,
              now() - interval '2 days', now() + ${trialDays ? `${trialDays} days` : "28 days"}::interval, ${overrides}::jsonb)`;

  await subscribe(managed.organizationId, "starter", "active", null);
  // 22 x 30s (1 minute each) + 125s (3 min) + 61s (2 min) = 27 billed minutes in 24 calls; + one 1s call (not billed)
  await addCalls(managed.organizationId, [...Array(22).fill(30), 125, 61, 1]);

  await subscribe(exhausted.organizationId, "trial", "trialing", 10);
  await addCalls(exhausted.organizationId, [30 * 60]); // all 30 trial minutes

  await subscribe(empty.organizationId, "trial", "trialing", 10);

  console.log("seeded billing UI fixtures");
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
