import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { systemContext, type RequestContext } from "../auth/context.js";

/** A system context for the seeded demo organization (where the demo data lives). */
export async function demoContext(): Promise<RequestContext> {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, "demo")).limit(1);
  if (!org) throw new Error("Demo organization missing — global test setup should have seeded it.");
  return systemContext(org.id, "test");
}
