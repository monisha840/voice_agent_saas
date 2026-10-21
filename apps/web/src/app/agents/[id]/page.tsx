import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createKnowledgeApi, type KnowledgeBaseSummary } from "@/lib/knowledge";
import { AgentBuilderBar } from "./AgentBuilderBar";
import { loadEditorData } from "../editorData";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { AgentEditor } from "../AgentEditor";

export default async function AgentDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const [agent, d, me] = await Promise.all([api.getAgent(params.id), loadEditorData(), api.me()]);
    const bases = await createKnowledgeApi(serverHeaders)
      .listBases(false)
      .catch((): KnowledgeBaseSummary[] | null => null);
    const role = me.organization?.role;
    return (
      <PageShell>
        <Link href="/agents" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ChevronLeft size={14} />
          Agents
        </Link>
        <AgentBuilderBar
          agentId={agent.id}
          active={agent.status === "active"}
          canManage={can(role, "agents:manage")}
          canTest={can(role, "calls:create")}
          bases={bases}
          boundIds={agent.knowledge.filter((k) => k.sourceType === "knowledge_base").map((k) => k.sourceId)}
        />
        <AgentEditor agent={agent} tools={d.tools} projects={d.projects} sales={d.sales} canManage={d.canManage} />
      </PageShell>
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <PageShell title="Agent">
        <LoadFailure err={err} what="Agent" />
      </PageShell>
    );
  }
}
