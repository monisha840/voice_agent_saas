import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { auditLogs } from "../schema.js";

/** Append-only: there is deliberately no update or delete. Every read is organization-scoped. */
export const auditRepository = {
  async insert(row: typeof auditLogs.$inferInsert) {
    const rows = await db.insert(auditLogs).values(row).returning();
    return rows[0];
  },

  async list(params: {
    organizationId: string;
    limit: number;
    before?: Date;
    action?: string;
    entityType?: string;
    entityId?: string;
  }) {
    const conds: SQL[] = [eq(auditLogs.organizationId, params.organizationId)];
    if (params.before) conds.push(lt(auditLogs.createdAt, params.before));
    if (params.action) conds.push(eq(auditLogs.action, params.action));
    if (params.entityType) conds.push(eq(auditLogs.entityType, params.entityType));
    if (params.entityId) conds.push(eq(auditLogs.entityId, params.entityId));
    return db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(params.limit);
  },
};
