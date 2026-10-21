import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import type { AgentOption, Lead } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { TestCallClient } from "./TestCallClient";

/**
 * Run a call against an agent. Works without the Sales module: a simulated call needs no phone number,
 * and a phone-number test needs no lead. Leads are offered as a target only when Sales is enabled.
 */
export default async function TestPage({ searchParams }: { searchParams: Promise<{ agentId?: string }> }) {
  const { agentId: requestedAgentId } = await searchParams;
  try {
    const me = await api.me();
    const sales = hasModule(me.organization, "sales");
    const [agents, leads] = await Promise.all([
      // The selection list works for every role that can place calls (no agents:read needed).
      api.listAgentOptions().catch((): AgentOption[] => []),
      sales ? api.listLeads().catch((): Lead[] => []) : Promise.resolve([] as Lead[]),
    ]);
    return (
      <PageShell title="Test" subtitle="Run a call against an agent and watch it live.">
        <TestCallClient
          agents={agents.filter((a) => a.status === "active")}
          leads={leads}
          sales={sales}
          initialAgentId={requestedAgentId}
        />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Test">
        <LoadFailure err={err} what="Test" />
      </PageShell>
    );
  }
}
