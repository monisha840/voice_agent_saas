import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import { counterpartyLabel, formatBudgetRange, formatDateTime } from "@/lib/format";
import type { Agent, CallListItem, CallStats, SalesOverview, UsageSummary } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { DailyBarChart } from "@/components/DailyBarChart";
import { EmptyState } from "@/components/StateViews";
import { Card, Notice } from "@/components/ui";

const DAYS = 30;

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-stone-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-stone-900">
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </div>
      {hint && <div className="mt-1 text-xs text-stone-500">{hint}</div>}
    </div>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800">
      {children} <ArrowRight size={14} />
    </Link>
  );
}

/**
 * Customer overview. Every number comes from the API's aggregates over persisted data, scoped on the server to the
 * signed-in organization and to what the user's role may see. Sections a role cannot read are left out.
 */
export default async function OverviewPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role ?? null;
    const sales = hasModule(me.organization, "sales");

    const to = new Date();
    const from = new Date(to.getTime() - DAYS * 24 * 60 * 60 * 1000);
    const [calls, recent, salesData, usage, agents] = await Promise.all([
      can(role, "calls:read") ? api.callStats(DAYS).catch((): CallStats | null => null) : Promise.resolve(null),
      can(role, "calls:read")
        ? api.listCalls({ limit: 5 }).then((r) => r.data).catch((): CallListItem[] | null => null)
        : Promise.resolve(null),
      sales && can(role, "leads:read") ? api.salesOverview(DAYS).catch((): SalesOverview | null => null) : Promise.resolve(null),
      can(role, "usage:read")
        ? api.usageSummary(from.toISOString(), to.toISOString()).catch((): UsageSummary | null => null)
        : Promise.resolve(null),
      can(role, "agents:read") ? api.listAgents(false).catch((): Agent[] | null => null) : Promise.resolve(null),
    ]);

    const leadsInfo = salesData?.leads ?? null;
    const activeAgents = (agents ?? []).filter((a) => a.status === "active");
    const defaultAgent = activeAgents.find((a) => a.isDefault) ?? null;
    const answerRate = calls && calls.total > 0 ? `${Math.round((calls.answered / calls.total) * 100)}% answered` : undefined;

    return (
      <PageShell title="Overview" subtitle={`Your agents, leads and calls. Activity covers the last ${DAYS} days.`}>
        <div className="space-y-6">
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {leadsInfo && <Stat label="Total leads" value={leadsInfo.total} hint={`${leadsInfo.newInWindow} new in ${DAYS} days`} />}
            {calls && <Stat label={`Calls, ${DAYS} days`} value={calls.total} hint={calls.active > 0 ? `${calls.active} in progress now` : undefined} />}
            {calls && <Stat label="Answered calls" value={calls.answered} hint={answerRate} />}
            {leadsInfo && (
              <Stat
                label="Interested leads"
                value={leadsInfo.interested}
                hint={`${leadsInfo.visitStage} at site-visit stage`}
              />
            )}
            {!leadsInfo && calls && (
              <Stat label="Talk time" value={`${Math.round(calls.talkSeconds / 60)} min`} hint="Connected calls" />
            )}
          </section>

          {(calls || leadsInfo) && (
            <section className="grid gap-6 lg:grid-cols-2">
              {calls && (
                <Card>
                  <DailyBarChart
                    title="Calls per day"
                    unit="calls"
                    points={calls.daily.map((d) => ({ day: d.day, value: d.total, detail: `${d.answered} answered` }))}
                  />
                </Card>
              )}
              {leadsInfo && (
                <Card>
                  <DailyBarChart title="New leads per day" unit="leads" points={leadsInfo.daily.map((d) => ({ day: d.day, value: d.total }))} />
                </Card>
              )}
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card title="Recent calls" action={<CardLink href="/calls">All calls</CardLink>}>
                {recent === null ? (
                  <Notice tone="info">Calls are not available to your role or could not be loaded.</Notice>
                ) : recent.length === 0 ? (
                  <EmptyState title="No calls yet" description="Place a test call from the Test page to see it here." />
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

              {salesData?.recentLeads && (
                <Card title="Recent leads" action={<CardLink href="/leads">All leads</CardLink>}>
                  {salesData.recentLeads.length === 0 ? (
                    <EmptyState title="No leads yet" description="Add a lead from the Leads page." />
                  ) : (
                    <ul className="-my-2 divide-y divide-stone-100">
                      {salesData.recentLeads.map((l) => (
                        <li key={l.id}>
                          <Link href={`/leads/${l.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                            <span className="min-w-0">
                              <span className="font-medium text-stone-900 hover:text-emerald-800">{l.name}</span>
                              <span className="ml-2 text-xs text-stone-500">
                                {l.requirementConfig ?? "Requirement not captured"} · {formatBudgetRange(l.budgetMin, l.budgetMax)}
                              </span>
                            </span>
                            <StatusBadge status={l.status} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </div>

            <div className="space-y-6">
              {salesData?.upcomingVisits && (
                <Card title="Upcoming site visits" action={<CardLink href="/site-visits">All visits</CardLink>}>
                  {salesData.upcomingVisits.data.length === 0 ? (
                    <p className="text-sm text-stone-500">No visits scheduled.</p>
                  ) : (
                    <ul className="-my-2 divide-y divide-stone-100">
                      {salesData.upcomingVisits.data.map((v) => (
                        <li key={v.id} className="py-2.5 text-sm">
                          <Link href={`/leads/${v.leadId}`} className="font-medium text-stone-900 hover:text-emerald-800">
                            {v.leadName}
                          </Link>
                          <div className="text-xs text-stone-500">
                            {formatDateTime(v.scheduledAt)} · {v.projectName}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {salesData.upcomingVisits.total > salesData.upcomingVisits.data.length && (
                    <p className="mt-3 text-xs text-stone-500">
                      {salesData.upcomingVisits.total - salesData.upcomingVisits.data.length} more scheduled
                    </p>
                  )}
                </Card>
              )}

              {agents && (
                <Card title="Agents" action={<CardLink href="/agents">Manage</CardLink>}>
                  <div className="text-sm font-medium text-stone-900">
                    {activeAgents.length} active agent{activeAgents.length === 1 ? "" : "s"}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">{defaultAgent ? `Default: ${defaultAgent.name}` : "No default agent set"}</p>
                  {calls && (
                    <p className="mt-3 text-xs text-stone-500">
                      {calls.active > 0 ? `${calls.active} call${calls.active === 1 ? "" : "s"} in progress` : "No calls in progress"}
                    </p>
                  )}
                </Card>
              )}

              {usage && (
                <Card title={`Usage, ${DAYS} days`} action={can(role, "usage:read") ? <CardLink href="/usage">Details</CardLink> : undefined}>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-stone-500">Minutes</dt>
                      <dd className="font-semibold tabular-nums text-stone-900">{Math.round(usage.totals.callSeconds / 60).toLocaleString("en-IN")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-stone-500">AI replies</dt>
                      <dd className="font-semibold tabular-nums text-stone-900">{usage.totals.aiTurns.toLocaleString("en-IN")}</dd>
                    </div>
                  </dl>
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
