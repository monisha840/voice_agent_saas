import { eq } from "drizzle-orm";
import { adminDb as db } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { systemContext, type RequestContext } from "../auth/context.js";

/** A system context for the seeded demo organization (where the demo data lives). */
export async function demoContext(): Promise<RequestContext> {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, "demo")).limit(1);
  if (!org) throw new Error("Demo organization missing — global test setup should have seeded it.");
  return systemContext(org.id, "test");
}

/** Asserts a promise rejects with a PostgreSQL error matching `pattern` (unwraps ORM error wrappers). */
export async function expectPgError(promise: Promise<unknown>, pattern: RegExp) {
  const { pgErrorMessage } = await import("../db/pg-error.js");
  let failure: unknown = null;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  if (failure === null) throw new Error("expected the statement to be rejected by the database, but it succeeded");
  const text = pgErrorMessage(failure);
  if (!pattern.test(text)) throw new Error(`database error did not match ${pattern}: ${text}`);
}
