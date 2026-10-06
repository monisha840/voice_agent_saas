import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { users } from "../schema.js";

export const usersRepository = {
  async findById(params: { id: string }) {
    const rows = await db.select().from(users).where(eq(users.id, params.id)).limit(1);
    return rows[0] ?? null;
  },
  async findByEmail(params: { email: string }) {
    const rows = await db.select().from(users).where(eq(users.email, params.email.trim().toLowerCase())).limit(1);
    return rows[0] ?? null;
  },
  async create(params: { email: string; name: string; passwordHash: string }) {
    const rows = await db
      .insert(users)
      .values({ email: params.email.trim().toLowerCase(), name: params.name.trim(), passwordHash: params.passwordHash })
      .returning();
    return rows[0];
  },
  async touchLogin(params: { id: string }) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, params.id));
  },
  async setPasswordHash(params: { id: string; passwordHash: string }) {
    await db.update(users).set({ passwordHash: params.passwordHash, updatedAt: new Date() }).where(eq(users.id, params.id));
  },
  async setActive(params: { id: string; isActive: boolean }) {
    await db.update(users).set({ isActive: params.isActive, updatedAt: new Date() }).where(eq(users.id, params.id));
  },
};
