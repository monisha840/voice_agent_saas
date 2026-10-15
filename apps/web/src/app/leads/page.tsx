import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { can } from "@/lib/permissions";
import type { TeamMember } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { ModuleDisabled } from "@/components/StateViews";
import { NewLeadButton } from "../NewLeadButton";
import { LeadsClient } from "./LeadsClient";

/** Sales module: the leads this user may work, with search, filters and paging. */
export default async function LeadsPage() {
  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <PageShell title="Leads">
          <ModuleDisabled />
        </PageShell>
      );
    }
    const role = me.organization?.role ?? null;
    const [projects, assignees] = await Promise.all([
      api.listProjects(),
      // The role only decides which controls to show; the API enforces the rules.
      can(role, "leads:assign") ? api.listUsers().catch((): TeamMember[] => []) : Promise.resolve([] as TeamMember[]),
    ]);
    return (
      <PageShell title="Leads" subtitle="Everyone your agents and team are working, newest first.">
        <LeadsClient
          projects={projects}
          headerAction={can(role, "leads:create") ? <NewLeadButton projects={projects} assignees={assignees} /> : undefined}
        />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Leads">
        <LoadFailure err={err} what="Leads" />
      </PageShell>
    );
  }
}
