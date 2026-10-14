/**
 * Seeds demo data for the MVP: one project (Green Valley Residency),
 * its approved project knowledge, and 4-5 demo leads.
 *
 * This is the ONLY place demo-specific data is hardcoded — never in
 * business logic/services, per MVP_IMPLEMENTATION_PLAN.md §9 / the
 * "do not hardcode Green Valley Residency into business logic" rule.
 *
 * Idempotent: running it multiple times does not create duplicates.
 * Usage: pnpm --filter @voice-agent/api db:seed
 */

import { loadEnv } from "../config/env.js";
loadEnv();

import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import {
  projects,
  projectKnowledge,
  leads,
  users,
  organizations,
  organizationModules,
  memberships,
  agents,
  agentKnowledgeBindings,
} from "../db/schema.js";
import { DEFAULT_SALES_CONFIG, SALES_TOOL_NAMES } from "../modules/sales/sales-constants.js";
import { DEFAULT_NEW_ORG_MODULES } from "../modules/modules/module-registry.js";
import { hashUnguessablePassword } from "../auth/password.js";
import { getConfig } from "../config/env.js";

const PROJECT_NAME = "Green Valley Residency";

async function seedProject(organizationId: string) {
  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.name, PROJECT_NAME)))
    .limit(1);
  if (existing[0]) {
    console.log(`Project "${PROJECT_NAME}" already exists, skipping creation.`);
    return existing[0];
  }

  const [project] = await db
    .insert(projects)
    .values({
      organizationId,
      name: PROJECT_NAME,
      location: "Whitefield, Bangalore",
      status: "active",
    })
    .returning();

  console.log(`Created project "${project.name}" (${project.id})`);
  return project;
}

async function seedProjectKnowledge(organizationId: string, projectId: string) {
  const existing = await db
    .select()
    .from(projectKnowledge)
    .where(eq(projectKnowledge.projectId, projectId));

  if (existing.length > 0) {
    console.log(`Project knowledge already exists for project ${projectId}, skipping.`);
    return;
  }

  const knowledgeRows = [
    {
      organizationId,
      projectId,
      category: "configurations" as const,
      content: {
        units: [
          { type: "2 BHK", areaSqft: 1150 },
          { type: "3 BHK", areaSqft: 1550 },
        ],
      },
    },
    {
      organizationId,
      projectId,
      category: "pricing" as const,
      content: {
        currency: "INR",
        ranges: [
          { type: "2 BHK", min: 6500000, max: 7800000 },
          { type: "3 BHK", min: 9500000, max: 11000000 },
        ],
        notes: "Approximate pricing; final price depends on floor and facing.",
      },
    },
    {
      organizationId,
      projectId,
      category: "amenities" as const,
      content: {
        items: [
          "Clubhouse",
          "Swimming pool",
          "Gym",
          "Children's play area",
          "24x7 security",
        ],
      },
    },
    {
      organizationId,
      projectId,
      category: "possession" as const,
      content: {
        expectedDate: "2026-12-31",
        notes: "Expected possession December 2026.",
      },
    },
    {
      organizationId,
      projectId,
      category: "location" as const,
      content: {
        address: "Whitefield, Bangalore",
        landmarks: ["Near ITPL", "5 km from Whitefield railway station"],
      },
    },
    {
      organizationId,
      projectId,
      category: "faq" as const,
      content: {
        items: [
          {
            question: "Is the project RERA registered?",
            answer: "Yes, the project is RERA registered.",
          },
          {
            question: "Is home loan assistance available?",
            answer: "Yes, tie-ups with multiple leading banks are available.",
          },
          {
            question: "What is the booking amount?",
            answer: "Booking amount is ₹2,00,000, adjustable against the final price.",
          },
          {
            question: "What are the maintenance charges?",
            answer: "Maintenance charges are approximately ₹3.5 per sq ft per month.",
          },
        ],
      },
    },
    // Structured versions of the facts in the FAQ above (the FAQ row stays as is).
    {
      organizationId,
      projectId,
      category: "rera" as const,
      content: { registrationNumber: "Registered", notes: "The project is RERA registered." },
    },
    {
      organizationId,
      projectId,
      category: "loan" as const,
      content: { assistanceAvailable: true, banks: ["Multiple leading banks"], notes: "Tie-ups with multiple leading banks are available." },
    },
    {
      organizationId,
      projectId,
      category: "booking" as const,
      content: { bookingAmount: 200000, currency: "INR", notes: "Adjustable against the final price." },
    },
    {
      organizationId,
      projectId,
      category: "maintenance" as const,
      content: { chargesPerSqftPerMonth: 3.5, currency: "INR", notes: "Approximate charges." },
    },
    // What callers ask beyond price and size (demo data; the structure is what matters).
    {
      organizationId,
      projectId,
      category: "nearby" as const,
      content: {
        items: [
          { name: "ITPL (International Tech Park)", type: "it_park", distanceKm: 3, travelMinutes: 10 },
          { name: "Whitefield railway station", type: "railway", distanceKm: 5, travelMinutes: 15 },
          { name: "Whitefield metro station", type: "metro", distanceKm: 4, travelMinutes: 12 },
          { name: "Phoenix Marketcity", type: "mall", distanceKm: 6, travelMinutes: 20 },
          { name: "Columbia Asia Hospital", type: "hospital", distanceKm: 3.5, travelMinutes: 12 },
          { name: "Delhi Public School", type: "school", distanceKm: 2, travelMinutes: 8 },
          { name: "Outer Ring Road", type: "highway", distanceKm: 2.5, travelMinutes: 8 },
          { name: "Kempegowda International Airport", type: "airport", distanceKm: 38, travelMinutes: 60 },
        ],
      },
    },
    {
      organizationId,
      projectId,
      category: "approvals" as const,
      content: { items: [{ authority: "BBMP", notes: "Approved building plan" }, { authority: "RERA Karnataka", number: "Registered" }] },
    },
    {
      organizationId,
      projectId,
      category: "builder" as const,
      content: { name: "Green Valley Developers", yearsInBusiness: 15, completedProjects: 12 },
    },
    {
      organizationId,
      projectId,
      category: "about" as const,
      content: { text: "Green Valley Residency is a gated community of 2 and 3 BHK homes in Whitefield, close to the IT corridor, with a clubhouse, pool and gym." },
    },
  ];

  await db.insert(projectKnowledge).values(knowledgeRows);
  console.log(`Inserted ${knowledgeRows.length} project knowledge rows for project ${projectId}.`);
}

async function seedLeads(organizationId: string, projectId: string) {
  const existing = await db.select().from(leads).where(eq(leads.projectId, projectId));
  if (existing.length > 0) {
    console.log(`Leads already exist for project ${projectId}, skipping.`);
    return;
  }

  const demoLeads = [
    {
      organizationId,
      projectId,
      name: "Rajesh Kumar",
      phone: "+919000000001",
      requirementConfig: "2 BHK",
      budgetMin: 6000000,
      budgetMax: 8000000,
    },
    {
      organizationId,
      projectId,
      name: "Priya Sharma",
      phone: "+919000000002",
      requirementConfig: "3 BHK",
      budgetMin: 9000000,
      budgetMax: 12000000,
    },
    {
      organizationId,
      projectId,
      name: "Anil Mehta",
      phone: "+919000000003",
      requirementConfig: "2 BHK",
      budgetMin: 5000000,
      budgetMax: 6500000,
    },
    {
      organizationId,
      projectId,
      name: "Sunita Rao",
      phone: "+919000000004",
      requirementConfig: "3 BHK",
      budgetMin: 10000000,
      budgetMax: 13000000,
    },
    {
      organizationId,
      projectId,
      name: "Vikram Singh",
      phone: "+919000000005",
      requirementConfig: "2 BHK",
      budgetMin: 6200000,
      budgetMax: 7500000,
    },
  ];

  await db.insert(leads).values(demoLeads);
  console.log(`Inserted ${demoLeads.length} demo leads for project ${projectId}.`);
}

/**
 * The demo user signs in only through the dev-only "demo login" button; its
 * password is random and nobody knows it. Real users are created by invite or
 * by the create-organization script.
 */
/** The demo organization the seed data (and the demo user) belongs to. */
export const DEMO_ORG_SLUG = "demo";

async function seedOrganization() {
  const existing = await db.select().from(organizations).where(eq(organizations.slug, DEMO_ORG_SLUG)).limit(1);
  let org = existing[0];
  if (!org) {
    [org] = await db.insert(organizations).values({ name: "Demo Organization", slug: DEMO_ORG_SLUG }).returning();
    console.log(`Created organization "${org.name}"`);
  }
  // The demo is the sales demo. Idempotent; never switches a module back on if someone turned it off.
  for (const moduleKey of DEFAULT_NEW_ORG_MODULES) {
    await db.insert(organizationModules).values({ organizationId: org.id, moduleKey }).onConflictDoNothing();
  }
  return org;
}

/**
 * Ensures the demo organization has a default agent that reproduces the original demo behaviour
 * (built-in persona, sales/real-estate prompt, every tool) bound to the demo project. If any agent
 * already exists (e.g. created by the migration backfill) nothing is changed.
 */
async function seedDefaultAgent(organizationId: string, projectId: string) {
  const existing = await db.select({ id: agents.id }).from(agents).where(eq(agents.organizationId, organizationId)).limit(1);
  if (existing[0]) return;
  const [agent] = await db
    .insert(agents)
    .values({
      organizationId,
      name: "Default agent",
      personaName: "Priya",
      companyName: null,
      promptTemplateKey: "sales_real_estate",
      enabledTools: [...SALES_TOOL_NAMES],
      moduleConfig: { sales: { ...DEFAULT_SALES_CONFIG } },
      behaviour: { maxResponseSentences: 3, endCallWhenDone: true, conversationQuestions: [] },
      isDefault: true,
    })
    .onConflictDoNothing()
    .returning();
  if (!agent) return;
  await db
    .insert(agentKnowledgeBindings)
    .values({ organizationId, agentId: agent.id, sourceType: "project", sourceId: projectId })
    .onConflictDoNothing();
  console.log(`Created default agent "${agent.name}" (${agent.id})`);
}

async function seedDemoUser() {
  const email = getConfig().auth.demoUserEmail.toLowerCase();
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return existing[0];
  const [user] = await db
    .insert(users)
    .values({ email, name: "Demo Owner", passwordHash: await hashUnguessablePassword() })
    .returning();
  console.log(`Created demo user ${email}`);
  return user;
}

export async function runSeed() {
  const org = await seedOrganization();
  const user = await seedDemoUser();
  await db
    .insert(memberships)
    .values({ organizationId: org.id, userId: user.id, role: "OWNER" })
    .onConflictDoNothing();
  const project = await seedProject(org.id);
  await seedProjectKnowledge(org.id, project.id);
  await seedDefaultAgent(org.id, project.id);
  await seedLeads(org.id, project.id);
  console.log("Seed complete.");
}

// Run only when executed directly (pnpm db:seed), not when imported by test setup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed()
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
    });
}
