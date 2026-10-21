import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { ModuleDisabled } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { ProjectsClient } from "./ProjectsClient";

export default async function ProjectsPage() {
  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <PageShell title="Projects">
          <ModuleDisabled />
        </PageShell>
      );
    }
    const projects = await api.listProjectsAll(true);
    return (
      <PageShell title="Projects" subtitle="Manage the properties your AI agent can talk about.">
        <ProjectsClient initial={projects} role={me.organization?.role ?? null} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Projects">
        <LoadFailure err={err} what="Projects" />
      </PageShell>
    );
  }
}
