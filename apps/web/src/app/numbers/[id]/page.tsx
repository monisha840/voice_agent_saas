import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createNumbersApi } from "@/lib/numbers";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { NumberDetailClient } from "./NumberDetailClient";

export const dynamic = "force-dynamic";

export default async function NumberDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const me = await api.me();
    const role = me.organization?.role;
    const number = await createNumbersApi(serverHeaders).get(params.id);
    const agents = can(role, "agents:manage") ? (await api.listAgents(false)).filter((a) => a.status === "active") : [];
    return (
      <PageShell>
        <Link href="/numbers" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ChevronLeft size={14} />
          Phone numbers
        </Link>
        <NumberDetailClient initial={number} agents={agents.map((a) => ({ id: a.id, name: a.name }))} canManage={can(role, "agents:manage")} />
      </PageShell>
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <PageShell title="Phone number">
        <LoadFailure err={err} what="Phone number" />
      </PageShell>
    );
  }
}
