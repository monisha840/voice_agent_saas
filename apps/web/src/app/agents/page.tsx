import Link from "next/link";
import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { AgentListClient } from "./AgentListClient";

export default async function AgentsPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role;
    if (!can(role, "agents:read")) {
      return (
        <PageShell title="Agents">
          <ErrorState
            title="You don't have permission"
            message="Only managers, admins and owners can view the AI agents."
          />
        </PageShell>
      );
    }
    const agents = await api.listAgents(true);
    return (
      <PageShell
        title="Agents"
        subtitle="Each agent has its own persona, prompt, tools and knowledge."
        actions={
          <Link href="/knowledge" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
            Knowledge base
          </Link>
        }
      >
        <AgentListClient agents={agents} canManage={can(role, "agents:manage")} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Agents">
        <LoadFailure err={err} what="Agents" />
      </PageShell>
    );
  }
}
