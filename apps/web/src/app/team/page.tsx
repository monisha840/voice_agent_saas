import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import type { Invitation } from "@/lib/types";
import { TeamClient } from "./TeamClient";

export default async function TeamPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role ?? null;
    if (!can(role, "users:read")) {
      return (
        <PageShell title="Team">
          <ErrorState title="You don't have permission" message="Only managers, admins and owners can view the team." />
        </PageShell>
      );
    }
    const users = await api.listUsers();
    const invitations: Invitation[] = can(role, "users:manage") ? await api.listInvitations().catch(() => []) : [];
    return (
      <PageShell title="Team" subtitle="People who can sign in to this organization.">
        <TeamClient initialUsers={users} initialInvitations={invitations} role={role} selfId={me.id} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Team">
        <LoadFailure err={err} what="Team" />
      </PageShell>
    );
  }
}
