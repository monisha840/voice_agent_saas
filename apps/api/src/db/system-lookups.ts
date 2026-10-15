/**
 * The ONLY cross-tenant reads the runtime is allowed: five SECURITY DEFINER functions (migration 0012) that map a
 * credential the caller already holds (a provider call id, a dialed number, an invitation token hash, a call id) to
 * the organization that owns it. They return an organization id, never a row, and each repository then does the real
 * work inside a normal tenant-scoped statement.
 *
 * These are reachable only from system flows (provider webhooks, the media stream, the reaper) and the public
 * accept-invitation endpoint; ordinary authenticated requests have no reason to call them.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

type Row = Record<string, string | null>;

async function one(query: ReturnType<typeof sql>, column: string): Promise<string | null> {
  const rows = (await db.execute(query)) as unknown as Row[];
  return rows[0]?.[column] ?? null;
}

export const systemLookups = {
  callOrgById(callId: string) {
    return one(sql`select app_resolve_call_org(${callId}::uuid) as org`, "org");
  },
  callOrgByProviderCallId(providerCallId: string) {
    return one(sql`select app_resolve_call_org_by_provider_id(${providerCallId}) as org`, "org");
  },
  projectOrgById(projectId: string) {
    return one(sql`select app_resolve_project_org(${projectId}::uuid) as org`, "org");
  },
  phoneNumberOrg(phoneNumber: string) {
    return one(sql`select app_resolve_phone_number_org(${phoneNumber}) as org`, "org");
  },
  invitationOrgByTokenHash(tokenHash: string) {
    return one(sql`select app_resolve_invitation_org(${tokenHash}) as org`, "org");
  },
  async staleCallRefs(params: { pendingBefore: Date; inProgressBefore: Date }) {
    const rows = (await db.execute(
      sql`select id, organization_id from app_list_stale_calls(${params.pendingBefore.toISOString()}::timestamptz, ${params.inProgressBefore.toISOString()}::timestamptz)`,
    )) as unknown as Array<{ id: string; organization_id: string }>;
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
  },
};
