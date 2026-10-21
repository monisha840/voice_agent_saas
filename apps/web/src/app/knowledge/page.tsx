import { api, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createKnowledgeApi } from "@/lib/knowledge";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { KnowledgeListClient } from "./KnowledgeListClient";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  try {
    const me = await api.me();
    const role = me.organization?.role;
    if (!can(role, "agents:read")) {
      return (
        <PageShell title="Knowledge base">
          <ErrorState title="You don't have permission" message="Only managers, admins and owners can view the knowledge base." />
        </PageShell>
      );
    }
    const bases = await createKnowledgeApi(serverHeaders).listBases(true);
    return (
      <PageShell title="Knowledge base" subtitle="FAQs, business information and documents your agents can look up during a conversation.">
        <KnowledgeListClient bases={bases} canManage={can(role, "agents:manage")} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Knowledge base">
        <LoadFailure err={err} what="Knowledge base" />
      </PageShell>
    );
  }
}
