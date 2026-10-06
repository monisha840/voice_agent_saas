/**
 * Backfills the structured rera/loan/booking/maintenance knowledge rows for
 * existing projects by parsing their FAQ answers.
 *
 * Idempotent and non-destructive: only inserts rows that are missing (the
 * unique (project, category) index plus ON CONFLICT DO NOTHING guarantees an
 * existing row is never overwritten), and skips a project/category when the FAQ
 * has no clear answer. Prints counts only.
 * Usage: pnpm exec tsx src/scripts/backfill-knowledge.ts
 */

import { loadEnv } from "../config/env.js";
loadEnv();

import { pathToFileURL } from "node:url";
import { db, sql } from "../db/client.js";
import { projectKnowledge, projects } from "../db/schema.js";
import { knowledgeSchemas } from "../modules/projects/knowledge.schemas.js";

type Faq = { question: string; answer: string };
type Category = "rera" | "loan" | "booking" | "maintenance";

const NEGATIVE = /\b(no|not|isn't|aren't|unavailable|without)\b/i;
const AMOUNT = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)?/i;

function toNumber(raw: string, unit?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  if (!unit) return n;
  return /^cr/i.test(unit) ? n * 10_000_000 : n * 100_000;
}

/** Builds the structured content for a category from its FAQ answer, or null when it cannot be read reliably. */
function parseAnswer(category: Category, answer: string): Record<string, unknown> | null {
  const notes = answer.slice(0, 1000);
  switch (category) {
    case "rera": {
      if (NEGATIVE.test(answer) || !/\b(yes|registered)\b/i.test(answer)) return null;
      const number = answer.match(/\b([A-Z]{2,}[A-Z0-9/-]*\d[A-Z0-9/-]{3,})\b/);
      return { registrationNumber: number?.[1] ?? "Registered", notes };
    }
    case "loan": {
      if (NEGATIVE.test(answer) || !/\b(yes|available|tie-?ups?|assistance)\b/i.test(answer)) return null;
      return { assistanceAvailable: true, notes };
    }
    case "booking": {
      const m = answer.match(AMOUNT);
      if (!m) return null;
      return { bookingAmount: Math.round(toNumber(m[1], m[2])), currency: "INR", notes };
    }
    case "maintenance": {
      const m = answer.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:per|\/)\s*sq/i);
      if (!m) return null;
      return { chargesPerSqftPerMonth: Number(m[1]), currency: "INR", notes };
    }
  }
}

const KEYWORDS: Record<Category, RegExp> = {
  rera: /rera/i,
  loan: /loan/i,
  booking: /booking/i,
  maintenance: /maintenance/i,
};

export async function backfillKnowledge() {
  const allProjects = await db.select({ id: projects.id, organizationId: projects.organizationId }).from(projects);
  const knowledge = await db.select().from(projectKnowledge);
  const byProject = new Map<string, Map<string, unknown>>();
  for (const k of knowledge) {
    if (!byProject.has(k.projectId)) byProject.set(k.projectId, new Map());
    byProject.get(k.projectId)!.set(k.category, k.content);
  }

  const counts = { projects: allProjects.length, inserted: 0, alreadyPresent: 0, skipped: 0 };
  for (const project of allProjects) {
    const rows = byProject.get(project.id) ?? new Map();
    const faq = ((rows.get("faq") as { items?: Faq[] } | undefined)?.items ?? []).filter(
      (i) => typeof i?.question === "string" && typeof i?.answer === "string",
    );
    for (const category of Object.keys(KEYWORDS) as Category[]) {
      if (rows.has(category)) {
        counts.alreadyPresent++;
        continue;
      }
      const item = faq.find((i) => KEYWORDS[category].test(i.question));
      const parsed = item ? parseAnswer(category, item.answer) : null;
      const valid = parsed ? knowledgeSchemas[category].safeParse(parsed) : null;
      if (!valid?.success) {
        counts.skipped++;
        continue;
      }
      const inserted = await db
        .insert(projectKnowledge)
        .values({ organizationId: project.organizationId, projectId: project.id, category, content: valid.data })
        .onConflictDoNothing()
        .returning({ id: projectKnowledge.id });
      if (inserted.length > 0) counts.inserted++;
      else counts.alreadyPresent++;
    }
  }
  console.log(
    `Backfill complete: ${counts.projects} projects, ${counts.inserted} rows inserted, ${counts.alreadyPresent} already present, ${counts.skipped} skipped (no usable FAQ answer).`,
  );
  return counts;
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillKnowledge()
    .catch((err) => {
      console.error("Backfill failed:", err instanceof Error ? err.message : "unknown error");
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
    });
}
