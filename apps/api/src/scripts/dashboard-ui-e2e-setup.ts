/**
 * Seeds the DISPOSABLE database used by the customer-dashboard browser e2e (apps/web/e2e/dashboard.e2e.ts).
 * Refuses any database whose name does not contain "dashboard_ui_test".
 *
 *   DATABASE_URL=<runtime url> DATABASE_ADMIN_URL=<owner url> tsx src/scripts/dashboard-ui-e2e-setup.ts
 *
 * Organizations (all users share UI_PASSWORD, Sales module on):
 *   Sunrise Realty   project "Lakeview Towers", 30 leads, calls with a transcript, visits   d-owner / d-agent @ui.test
 *   Other Realty     one lead "Hidden Other Lead" (must never be visible to Sunrise users)    o-owner@ui.test
 */
import { loadEnv } from "../config/env.js";
loadEnv();

import { adminSql, sql } from "../db/client.js";
import { hashPassword } from "../auth/password.js";
import { createOrg } from "./create-org.js";

export const UI_PASSWORD = "UiTest-Passw0rd-1";
const DAY = 86_400_000;

async function main() {
  const name = new URL(process.env.DATABASE_ADMIN_URL ?? "").pathname.replace(/^\//, "");
  if (!/dashboard_ui_test/.test(name)) throw new Error(`Refusing to seed "${name}": database name must contain "dashboard_ui_test"`);
  const q = adminSql;
  if (!q) throw new Error("DATABASE_ADMIN_URL required");

  const sunrise = await createOrg({ orgName: "Sunrise Realty", orgSlug: "sunrise-realty", ownerEmail: "d-owner@ui.test", ownerName: "Dana Owner", ownerPassword: UI_PASSWORD, modules: ["sales"] });
  const other = await createOrg({ orgName: "Other Realty", orgSlug: "other-realty", ownerEmail: "o-owner@ui.test", ownerName: "Olu Owner", ownerPassword: UI_PASSWORD, modules: ["sales"] });

  const hash = await hashPassword(UI_PASSWORD);
  const [agentUser] = await q`insert into users (email, name, password_hash) values ('d-agent@ui.test', 'Devi Agent', ${hash}) returning id`;
  await q`insert into memberships (organization_id, user_id, role) values (${sunrise.organizationId}, ${agentUser.id}, 'AGENT'::org_role)`;

  const projectOf = async (orgId: string, projectName: string, location: string) =>
    (await q`insert into projects (organization_id, name, location) values (${orgId}, ${projectName}, ${location}) returning id`)[0].id as string;
  const sunriseProject = await projectOf(sunrise.organizationId, "Lakeview Towers", "Chennai");
  const otherProject = await projectOf(other.organizationId, "Hidden Heights", "Pune");
  const agentOf = async (orgId: string) => (await q`select id from agents where organization_id = ${orgId} limit 1`)[0].id as string;
  const sunriseAgent = await agentOf(sunrise.organizationId);

  const lead = async (orgId: string, projectId: string, leadName: string, phone: string, status = "NEW", ageDays = 0) =>
    (
      await q`insert into leads (organization_id, project_id, name, phone, status, requirement_config, budget_min, budget_max, created_at, updated_at)
              values (${orgId}, ${projectId}, ${leadName}, ${phone}, ${status}::lead_status, '2 BHK', 6000000, 8000000,
                      now() - ${`${ageDays} days`}::interval, now() - ${`${ageDays} days`}::interval)
              returning id`
    )[0].id as string;

  // 27 filler leads + 3 named ones = 30 (more than one 25-row page).
  for (let i = 1; i <= 27; i++) {
    await lead(sunrise.organizationId, sunriseProject, `Buyer ${String(i).padStart(2, "0")}`, `+9198200${String(10000 + i).slice(-5)}`, "NEW", (i % 10) + 1);
  }
  const priya = await lead(sunrise.organizationId, sunriseProject, "Priya Raman", "+919811100001", "INTERESTED");
  const arun = await lead(sunrise.organizationId, sunriseProject, "Arun Kumar", "+919811100002", "VISIT_BOOKED");
  const meena = await lead(sunrise.organizationId, sunriseProject, "Meena Iyer", "+919811100003", "QUALIFICATION");
  await lead(other.organizationId, otherProject, "Hidden Other Lead", "+919811100099", "INTERESTED");

  // Priya: one answered call with a transcript and summary; Meena: one call that never connected.
  const started = new Date(Date.now() - 2 * 3600_000);
  const [answered] = await q`insert into calls (organization_id, agent_id, lead_id, status, call_type, counterparty_number, counterparty_name, created_at, started_at, ended_at)
                             values (${sunrise.organizationId}, ${sunriseAgent}, ${priya}, 'completed', 'outbound', '+919811100001', 'Priya Raman',
                                     ${new Date(started.getTime() - 15_000).toISOString()}::timestamptz, ${started.toISOString()}::timestamptz, ${new Date(started.getTime() + 185_000).toISOString()}::timestamptz)
                             returning id`;
  await q`insert into conversations (organization_id, call_id, transcript, summary, qualification)
          values (${sunrise.organizationId}, ${answered.id},
                  ${JSON.stringify([
                    { speaker: "ai", text: "Hello Priya, this is Asha from Sunrise Realty about Lakeview Towers.", timestamp: started.toISOString() },
                    { speaker: "lead", text: "Yes, I am looking for a 2 BHK near the lake.", timestamp: started.toISOString() },
                  ])}::jsonb,
                  'Priya wants a 2 BHK and asked about prices.',
                  ${JSON.stringify({
                    summary: "Priya wants a 2 BHK.",
                    interestLevel: "high",
                    configuration: "2 BHK",
                    budget: "60-80 lakh",
                    purchaseTimeline: null,
                    loanRequirement: null,
                    locationPreference: null,
                    customerQuestions: [],
                    siteVisitStatus: "offered",
                    recommendedNextAction: "Share the price sheet",
                    recommendedLeadStatus: "INTERESTED",
                  })}::jsonb)`;
  await q`insert into calls (organization_id, agent_id, lead_id, status, call_type, counterparty_number, counterparty_name)
          values (${sunrise.organizationId}, ${sunriseAgent}, ${meena}, 'failed', 'outbound', '+919811100003', 'Meena Iyer')`;
  // An inbound call, so the call page can show the line the caller dialled (migration 0024).
  const inboundStart = new Date(Date.now() - 3600_000);
  await q`insert into calls (organization_id, agent_id, status, call_type, counterparty_number, counterparty_name, line_number, created_at, started_at, ended_at)
          values (${sunrise.organizationId}, ${sunriseAgent}, 'completed', 'inbound', '+919811100007', 'Walk-in Caller', '+918045000111',
                  ${inboundStart.toISOString()}::timestamptz, ${inboundStart.toISOString()}::timestamptz, ${new Date(inboundStart.getTime() + 95_000).toISOString()}::timestamptz)`;

  // Arun: an upcoming visit; Meena: a visit in the past.
  await q`insert into site_visits (organization_id, lead_id, project_id, scheduled_at)
          values (${sunrise.organizationId}, ${arun}, ${sunriseProject}, ${new Date(Date.now() + 3 * DAY).toISOString()}::timestamptz)`;
  await q`insert into site_visits (organization_id, lead_id, project_id, scheduled_at)
          values (${sunrise.organizationId}, ${meena}, ${sunriseProject}, ${new Date(Date.now() - 2 * DAY).toISOString()}::timestamptz)`;

  console.log("seeded dashboard UI fixtures");
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
