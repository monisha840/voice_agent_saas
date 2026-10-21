import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { LoadFailure, PageShell } from "@/components/PageShell";
import type { ProjectMember, TeamMember } from "@/lib/types";
import { ProjectDetailClient } from "./ProjectDetailClient";

export default async function ProjectDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const [me, project] = await Promise.all([api.me(), api.getProject(params.id)]);
    const role = me.organization?.role ?? null;

    // Member management is OWNER/ADMIN only; other roles never load these lists.
    let members: ProjectMember[] = [];
    let team: TeamMember[] = [];
    if (can(role, "projects:members")) {
      [members, team] = await Promise.all([
        api.listProjectMembers(params.id).catch(() => []),
        api.listUsers().catch(() => []),
      ]);
    }

    return (
      <PageShell>
        <ProjectDetailClient project={project} role={role} initialMembers={members} team={team} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell>
        <LoadFailure err={err} what="Project" />
      </PageShell>
    );
  }
}
