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

import { eq } from "drizzle-orm";
import { db, sql } from "../db/client.js";
import { projects, projectKnowledge, leads } from "../db/schema.js";

const PROJECT_NAME = "Green Valley Residency";

async function seedProject() {
  const existing = await db.select().from(projects).where(eq(projects.name, PROJECT_NAME)).limit(1);
  if (existing[0]) {
    console.log(`Project "${PROJECT_NAME}" already exists, skipping creation.`);
    return existing[0];
  }

  const [project] = await db
    .insert(projects)
    .values({
      name: PROJECT_NAME,
      location: "Whitefield, Bangalore",
      status: "active",
    })
    .returning();

  console.log(`Created project "${project.name}" (${project.id})`);
  return project;
}

async function seedProjectKnowledge(projectId: string) {
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
      projectId,
      category: "possession" as const,
      content: {
        expectedDate: "2026-12-31",
        notes: "Expected possession December 2026.",
      },
    },
    {
      projectId,
      category: "location" as const,
      content: {
        address: "Whitefield, Bangalore",
        landmarks: ["Near ITPL", "5 km from Whitefield railway station"],
      },
    },
    {
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
  ];

  await db.insert(projectKnowledge).values(knowledgeRows);
  console.log(`Inserted ${knowledgeRows.length} project knowledge rows for project ${projectId}.`);
}

async function seedLeads(projectId: string) {
  const existing = await db.select().from(leads).where(eq(leads.projectId, projectId));
  if (existing.length > 0) {
    console.log(`Leads already exist for project ${projectId}, skipping.`);
    return;
  }

  const demoLeads = [
    {
      projectId,
      name: "Rajesh Kumar",
      phone: "+919000000001",
      requirementConfig: "2 BHK",
      budgetMin: 6000000,
      budgetMax: 8000000,
    },
    {
      projectId,
      name: "Priya Sharma",
      phone: "+919000000002",
      requirementConfig: "3 BHK",
      budgetMin: 9000000,
      budgetMax: 12000000,
    },
    {
      projectId,
      name: "Anil Mehta",
      phone: "+919000000003",
      requirementConfig: "2 BHK",
      budgetMin: 5000000,
      budgetMax: 6500000,
    },
    {
      projectId,
      name: "Sunita Rao",
      phone: "+919000000004",
      requirementConfig: "3 BHK",
      budgetMin: 10000000,
      budgetMax: 13000000,
    },
    {
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

async function main() {
  const project = await seedProject();
  await seedProjectKnowledge(project.id);
  await seedLeads(project.id);
  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
