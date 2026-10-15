import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { PlaygroundClient } from "./PlaygroundClient";

export const dynamic = "force-dynamic";

export default async function PlaygroundPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const me = await api.me();
    const role = me.organization?.role;
    if (!can(role, "agents:read") || !can(role, "calls:create")) {
      return (
        <PageShell title="Test playground">
          <ErrorState title="You don't have permission" message="Testing an agent needs access to agents and to placing calls." />
        </PageShell>
      );
    }
    const agent = await api.getAgent(params.id);
    return (
      <PageShell>
        <Link href={`/agents/${agent.id}`} className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
          <ChevronLeft size={14} />
          {agent.name}
        </Link>
        <PlaygroundClient agent={{ id: agent.id, name: agent.name, personaName: agent.personaName, language: agent.language, status: agent.status }} />
      </PageShell>
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <PageShell title="Test playground">
        <LoadFailure err={err} what="Agent" />
      </PageShell>
    );
  }
}
