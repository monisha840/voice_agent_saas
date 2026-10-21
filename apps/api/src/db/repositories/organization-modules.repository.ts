import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { organizationModules } from "../schema.js";

export const organizationModulesRepository = {
  async listForOrganization(params: { organizationId: string }) {
    return db.select().from(organizationModules).where(eq(organizationModules.organizationId, params.organizationId));
  },

  async listEnabledKeys(params: { organizationId: string }): Promise<string[]> {
    const rows = await db
      .select({ key: organizationModules.moduleKey })
      .from(organizationModules)
      .where(and(eq(organizationModules.organizationId, params.organizationId), eq(organizationModules.enabled, true)));
    return rows.map((r) => r.key);
  },

  async isEnabled(params: { organizationId: string; moduleKey: string }): Promise<boolean> {
    const rows = await db
      .select({ enabled: organizationModules.enabled })
      .from(organizationModules)
      .where(
        and(eq(organizationModules.organizationId, params.organizationId), eq(organizationModules.moduleKey, params.moduleKey)),
      )
      .limit(1);
    return rows[0]?.enabled === true;
  },

  /** Creates the row or flips `enabled`; existing config is left untouched. */
  async setEnabled(params: { organizationId: string; moduleKey: string; enabled: boolean }) {
    const rows = await db
      .insert(organizationModules)
      .values({ organizationId: params.organizationId, moduleKey: params.moduleKey, enabled: params.enabled })
      .onConflictDoUpdate({
        target: [organizationModules.organizationId, organizationModules.moduleKey],
        set: { enabled: params.enabled, updatedAt: new Date() },
      })
      .returning();
    return rows[0];
  },
};
