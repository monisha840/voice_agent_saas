import { api } from "@/lib/api.server";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { can } from "@/lib/permissions";
import type { AgentOption } from "@/lib/types";
import { CallsClient } from "./CallsClient";

export default async function CallsPage() {
  try {
    const me = await api.me();
    const [first, agents] = await Promise.all([
      api.listCalls({ limit: 25 }),
      // Agents feed the filter. Roles that may read agents also get archived ones (old calls); everyone else gets the
      // active-agent selection list, which needs no agents permission.
      (can(me.organization?.role, "agents:read") ? api.listAgents(true) : api.listAgentOptions()).catch((): AgentOption[] => []),
    ]);
    return (
      <PageShell title="Calls" subtitle="Every call your voice agents have made or received.">
        <CallsClient initial={first.data} initialNext={first.nextBefore} agents={agents} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Calls">
        <LoadFailure err={err} what="Calls" />
      </PageShell>
    );
  }
}
