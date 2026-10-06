import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api.server";
import { loadEditorData } from "../editorData";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { AgentEditor } from "../AgentEditor";

export default async function AgentDetailPage({ params }: { params: { id: string } }) {
  try {
    const [agent, d] = await Promise.all([api.getAgent(params.id), loadEditorData()]);
    return (
      <PageShell>
        <Link href="/agents" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ChevronLeft size={14} />
          Agents
        </Link>
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
