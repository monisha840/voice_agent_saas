import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createKnowledgeApi } from "@/lib/knowledge";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { KnowledgeDetailClient } from "./KnowledgeDetailClient";

export const dynamic = "force-dynamic";

export default async function KnowledgeDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const me = await api.me();
    const kb = await createKnowledgeApi(serverHeaders).getBase(params.id);
    return (
      <PageShell>
        <Link href="/knowledge" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ChevronLeft size={14} />
          Knowledge base
        </Link>
        <KnowledgeDetailClient initial={kb} canManage={can(me.organization?.role, "agents:manage")} />
      </PageShell>
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <PageShell title="Knowledge base">
        <LoadFailure err={err} what="Knowledge base" />
      </PageShell>
    );
  }
}
