/**
 * Test fixtures for multi-tenancy: whole tenants (organization + owner user +
 * project + lead + call + conversation + site visit) built through the same
 * tables production uses, so isolation tests exercise real data.
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentConfigs,
  agents,
  auditLogs,
  calls,
  conversations,
  invitations,
  leads,
  memberships,
  organizationModules,
  organizations,
  projectKnowledge,
  projectMembers,
  projects,
  siteVisits,
  usageEvents,
  users,
} from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import type { OrgRole } from "../auth/context.js";

export const TEST_PASSWORD = "tenant-test-password-123";

export interface TestTenant {
  label: string;
  orgId: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  leadId: string;
  callId: string;
  siteVisitId: string;
  /** The tenant's default agent (every call belongs to an agent). */
  agentId: string;
}

const created = { orgIds: [] as string[], userIds: [] as string[] };
const rand = () => randomBytes(4).toString("hex");

/** A user with a given role in an existing organization. */
export async function createMember(orgId: string, role: OrgRole, label = role.toLowerCase()) {
  const email = `${label}-${rand()}@example.test`;
  const [user] = await db
    .insert(users)
    .values({ email, name: `${label} user`, passwordHash: await hashPassword(TEST_PASSWORD) })
    .returning();
  created.userIds.push(user.id);
  await db.insert(memberships).values({ organizationId: orgId, userId: user.id, role });
  return { userId: user.id, email };
}

const ALL_TOOLS = [
  "get_project_details",
  "get_project_price",
  "get_project_configurations",
  "get_project_location",
  "check_visit_slots",
  "book_site_visit",
  "update_lead",
  "mark_not_interested",
  "end_call",
];

/** A default agent shaped like the one the 0007 backfill / seed gives a real-estate organization. */
export async function createDefaultAgent(orgId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await db
    .insert(agents)
    .values({
      organizationId: orgId,
      name: "Default agent",
      personaName: "Priya",
      promptTemplateKey: "sales_real_estate",
      isDefault: true,
      enabledTools: ALL_TOOLS,
      moduleConfig: { sales: { offerSlots: 3, autoBook: true } },
      ...overrides,
    })
    .returning();
  return agent;
}

/** The default agent of an existing organization (e.g. the seeded demo org). */
export async function defaultAgentIdFor(orgId: string): Promise<string> {
  const rows = await db.select().from(agents).where(and(eq(agents.organizationId, orgId), eq(agents.isDefault, true))).limit(1);
  if (!rows[0]) throw new Error(`Organization ${orgId} has no default agent`);
  return rows[0].id;
}

export async function createTenant(label: string, opts: { modules?: string[] } = {}): Promise<TestTenant> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `Tenant ${label}`, slug: `t-${label.toLowerCase()}-${rand()}` })
    .returning();
  created.orgIds.push(org.id);
  // Like a freshly created organization: the sales module is on unless a test says otherwise.
  for (const moduleKey of opts.modules ?? ["sales"]) {
    await db.insert(organizationModules).values({ organizationId: org.id, moduleKey, enabled: true });
  }
  const owner = await createMember(org.id, "OWNER", `owner-${label.toLowerCase()}`);
  const agent = await createDefaultAgent(org.id);

  const projectName = `${label} Heights`;
  const [project] = await db
    .insert(projects)
    .values({ organizationId: org.id, name: projectName, location: `${label} City` })
    .returning();
  await db.insert(projectKnowledge).values({
    organizationId: org.id,
    projectId: project.id,
    category: "pricing",
    content: { currency: "INR", ranges: [{ type: "2 BHK", min: 1, max: 2 }] },
  });
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId: org.id,
      projectId: project.id,
      name: `${label} Lead`,
      phone: label === "A" ? "+919000010001" : "+919000010002",
    })
    .returning();
  const [call] = await db
    .insert(calls)
    .values({ organizationId: org.id, agentId: agent.id, leadId: lead.id, status: "completed", providerCallId: `test-${label}-${rand()}` })
    .returning();
  await db.insert(conversations).values({
    organizationId: org.id,
    callId: call.id,
    transcript: [{ speaker: "lead", text: `secret of ${label}`, timestamp: new Date().toISOString() }],
    summary: `summary of ${label}`,
  });
  const [visit] = await db
    .insert(siteVisits)
    .values({ organizationId: org.id, leadId: lead.id, projectId: project.id, scheduledAt: new Date(Date.now() + 86_400_000) })
    .returning();

  return {
    label,
    orgId: org.id,
    userId: owner.userId,
    email: owner.email,
    projectId: project.id,
    projectName,
    leadId: lead.id,
    callId: call.id,
    siteVisitId: visit.id,
    agentId: agent.id,
  };
}

/** Deletes everything created by createTenant/createMember in this test file. */
export async function cleanupTenants() {
  if (created.orgIds.length > 0) {
    // Append-only / dependent tables first (audit and usage are restricted by FK, so they must go before the organization).
    await db.delete(usageEvents).where(inArray(usageEvents.organizationId, created.orgIds));
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, created.orgIds));
    await db.delete(agentConfigs).where(inArray(agentConfigs.organizationId, created.orgIds));
    await db.delete(organizationModules).where(inArray(organizationModules.organizationId, created.orgIds));
    await db.delete(projectMembers).where(inArray(projectMembers.organizationId, created.orgIds));
    await db.delete(invitations).where(inArray(invitations.organizationId, created.orgIds));
    // calls (incl. any without a lead) cascade to conversations; agents restrict-reference nothing else once calls are gone
    await db.delete(calls).where(inArray(calls.organizationId, created.orgIds));
    // leads cascade to site visits; projects cascade to knowledge
    await db.delete(leads).where(inArray(leads.organizationId, created.orgIds));
    await db.delete(projects).where(inArray(projects.organizationId, created.orgIds));
    await db.delete(agents).where(inArray(agents.organizationId, created.orgIds)); // bindings cascade
    await db.delete(memberships).where(inArray(memberships.organizationId, created.orgIds));
    for (const id of created.orgIds) await db.delete(organizations).where(eq(organizations.id, id));
  }
  if (created.userIds.length > 0) await db.delete(users).where(inArray(users.id, created.userIds));
  created.orgIds.length = 0;
  created.userIds.length = 0;
}

/** Logs in over HTTP and returns the Cookie header value. */
export async function loginCookie(baseUrl: string, email: string, password = TEST_PASSWORD): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0].split(";")[0];
}
