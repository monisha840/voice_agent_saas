import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";
import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import { counterpartyLabel, formatDateTime } from "@/lib/format";
import type { Agent, CallListItem, UsageSummary } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { UsageTiles } from "@/components/UsageTiles";
import { EmptyState } from "@/components/StateViews";
import { Card, Notice } from "@/components/ui";

/** Voice AI core overview: usage, the active agent and recent calls. Nothing here depends on an optional module. */
export default async function OverviewPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role ?? null;
    const sales = hasModule(me.organization, "sales");

    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [recent, usage, agents] = await Promise.all([
      can(role, "calls:read")
        ? api.listCalls({ limit: 5 }).then((r) => r.data).catch((): CallListItem[] | null => null)
        : Promise.resolve(null),
      can(role, "usage:read")
        ? api.usageSummary(from.toISOString(), to.toISOString()).catch((): UsageSummary | null => null)
        : Promise.resolve(null),
      can(role, "agents:read")
        ? api.listAgents(false).catch((): Agent[] | null => null)
        : Promise.resolve(null),
    ]);

    const activeAgents = (agents ?? []).filter((a) => a.status === "active");
    const defaultAgent = activeAgents.find((a) => a.isDefault) ?? null;

    return (
      <PageShell title="Overview" subtitle="Your voice agents, calls and usage at a glance.">
        <div className="space-y-6">
          {usage && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-stone-900">Usage, last 30 days</h2>
              <UsageTiles usage={usage} showSiteVisits={sales} />
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card
                title="Recent calls"
                action={
                  <Link
                    href="/calls"
                    className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                  >
                    All calls <ArrowRight size={14} />
                  </Link>
                }
              >
                {recent === null ? (
                  <Notice tone="info">Calls are not available to your role or could not be loaded.</Notice>
                ) : recent.length === 0 ? (
                  <EmptyState title="No calls yet" description="Run a test call to see it here." />
                ) : (
                  <ul className="-my-2 divide-y divide-stone-100">
                    {recent.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/calls/${c.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm hover:text-emerald-800"
                        >
                          <span className="font-medium text-stone-900">{counterpartyLabel(c)}</span>
                          <span className="flex items-center gap-3 text-xs text-stone-500">
                            <CallStatusBadge status={c.status} />
                            {formatDateTime(c.createdAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <div className="space-y-6">
              {agents && (
                <Card title="Agents" action={<Bot size={14} className="text-stone-300" />}>
                  <div className="text-sm font-medium text-stone-900">
                    {activeAgents.length} active agent{activeAgents.length === 1 ? "" : "s"}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {defaultAgent ? `Default: ${defaultAgent.name}` : "No default agent set"}
                  </p>
                  <Link
                    href="/agents"
                    className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                  >
                    Manage agents <ArrowRight size={14} />
                  </Link>
                </Card>
              )}
              {sales && (
                <Card title="Sales module">
                  <p className="text-sm text-stone-500">Leads, projects and site visits for outbound sales calls.</p>
                  <Link
                    href="/leads"
                    className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                  >
                    Open leads <ArrowRight size={14} />
                  </Link>
                </Card>
              )}
            </div>
          </div>
        </div>
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Overview">
        <LoadFailure err={err} what="Overview" />
      </PageShell>
    );
  }
}
