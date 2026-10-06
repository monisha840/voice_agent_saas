import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { organizations } from "../schema.js";

export const organizationsRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(organizations).where(eq(organizations.id, params.id)).limit(1);
    return rows[0] ?? null;
  },
  async findBySlug(params: { slug: string }) {
    const rows = await db.select().from(organizations).where(eq(organizations.slug, params.slug)).limit(1);
    return rows[0] ?? null;
  },
  async create(params: { name: string; slug: string }) {
    const rows = await db.insert(organizations).values({ name: params.name.trim(), slug: params.slug }).returning();
    return rows[0];
  },
  async rename(params: { id: string; name: string }) {
    const rows = await db
      .update(organizations)
      .set({ name: params.name.trim(), updatedAt: new Date() })
      .where(eq(organizations.id, params.id))
      .returning();
    return rows[0] ?? null;
  },
};
