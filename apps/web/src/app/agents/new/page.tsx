import { loadEditorData } from "../editorData";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { ErrorState } from "@/components/StateViews";
import { AgentEditor } from "../AgentEditor";

export default async function NewAgentPage() {
  try {
    const d = await loadEditorData();
    if (!d.canManage) {
      return (
        <PageShell title="New agent">
          <ErrorState title="You don't have permission" message="Only admins and owners can create agents." />
        </PageShell>
      );
    }
    return (
      <PageShell title="New agent" subtitle="Define who the agent is and how it handles calls.">
        <AgentEditor agent={null} tools={d.tools} projects={d.projects} sales={d.sales} canManage />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="New agent">
        <LoadFailure err={err} what="Agent editor" />
      </PageShell>
    );
  }
}
