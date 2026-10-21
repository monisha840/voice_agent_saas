import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb as db } from "../db/client.js";
import { projectKnowledge, projects } from "../db/schema.js";
import { backfillKnowledge } from "./backfill-knowledge.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { cleanupTenants, createTenant } from "../test/tenants.js";

afterAll(cleanupTenants);

async function rowsOf(projectId: string) {
  return db.select().from(projectKnowledge).where(eq(projectKnowledge.projectId, projectId));
}

describe("backfill-knowledge", () => {
  it("inserts missing rows from FAQ answers, never overwrites, skips unreadable answers, and is idempotent", async () => {
    const t = await createTenant("F");
    const [noFaq] = await db.insert(projects).values({ organizationId: t.orgId, name: "No FAQ", location: "X" }).returning();
    await db.insert(projectKnowledge).values([
      {
        organizationId: t.orgId,
        projectId: t.projectId,
        category: "faq",
        content: {
          items: [
            { question: "Is it RERA registered?", answer: "Yes, registered under PRM/KA/RERA/1251/309." },
            { question: "Home loan help?", answer: "Yes, tie-ups with multiple banks." },
            { question: "Booking amount?", answer: "Booking amount is Rs. 2 lakh." },
            { question: "Maintenance charges?", answer: "It depends, ask the sales team." },
          ],
        },
      },
      { organizationId: t.orgId, projectId: t.projectId, category: "booking", content: { bookingAmount: 5, currency: "INR" } },
    ]);

    await runAsAdmin(() => backfillKnowledge());
    const byCat = Object.fromEntries((await rowsOf(t.projectId)).map((r) => [r.category, r.content]));
    expect(byCat.rera).toMatchObject({ registrationNumber: "PRM/KA/RERA/1251/309" });
    expect(byCat.loan).toMatchObject({ assistanceAvailable: true });
    expect(byCat.booking).toEqual({ bookingAmount: 5, currency: "INR" }); // existing row untouched
    expect(byCat.maintenance).toBeUndefined(); // no usable answer
    expect(await rowsOf(noFaq.id)).toHaveLength(0);

    const before = (await rowsOf(t.projectId)).length;
    const second = await runAsAdmin(() => backfillKnowledge());
    expect((await rowsOf(t.projectId)).length).toBe(before);
    expect(second.inserted).toBe(0);
  });

  it("parses amounts in lakh and per-sqft maintenance, and refuses negative answers", async () => {
    const t = await createTenant("G");
    await db.insert(projectKnowledge).values({
      organizationId: t.orgId,
      projectId: t.projectId,
      category: "faq",
      content: {
        items: [
          { question: "RERA?", answer: "No, not yet registered." },
          { question: "Loan?", answer: "No loan assistance." },
          { question: "Booking", answer: "Booking amount is Rs. 2 lakh." },
          { question: "Maintenance", answer: "Approximately Rs 4.25 per sq ft per month." },
        ],
      },
    });
    await runAsAdmin(() => backfillKnowledge());
    const rows = await db
      .select()
      .from(projectKnowledge)
      .where(and(eq(projectKnowledge.projectId, t.projectId)));
    const byCat = Object.fromEntries(rows.map((r) => [r.category, r.content]));
    expect(byCat.rera).toBeUndefined();
    expect(byCat.loan).toBeUndefined();
    expect(byCat.booking).toMatchObject({ bookingAmount: 200000 });
    expect(byCat.maintenance).toMatchObject({ chargesPerSqftPerMonth: 4.25 });
  });
});
