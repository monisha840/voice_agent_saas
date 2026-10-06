import Link from "next/link";
import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { formatDateTime } from "@/lib/format";
import type { Project } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { EmptyState, ModuleDisabled } from "@/components/StateViews";
import { Badge, Card } from "@/components/ui";

/** Sales module: scheduled site visits. */
export default async function SiteVisitsPage() {
  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <PageShell title="Site visits">
          <ModuleDisabled />
        </PageShell>
      );
    }
    const [visits, projects] = await Promise.all([
      api.listSiteVisits(),
      api.listProjectsAll(true).catch((): Project[] => []),
    ]);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    return (
      <PageShell title="Site visits" subtitle="Visits booked by your agents or team.">
        <Card>
          {visits.length === 0 ? (
            <EmptyState title="No site visits" description="Booked visits will appear here." />
          ) : (
            <div className="-my-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-stone-400">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Lead</th>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Scheduled</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {visits.map((v) => (
                    <tr key={v.id}>
                      <td className="py-2.5 pr-4">
                        <Link href={`/leads/${v.leadId}`} className="font-medium text-emerald-700 hover:text-emerald-800">
                          {v.leadName ?? `Lead ${v.leadId.slice(0, 8)}`}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-stone-700">
                        {v.projectName ?? projectName.get(v.projectId) ?? v.projectId.slice(0, 8)}
                      </td>
                      <td className="py-2.5 pr-4 text-stone-700">{formatDateTime(v.scheduledAt)}</td>
                      <td className="py-2.5">
                        <Badge tone={v.status === "booked" ? "success" : "neutral"}>{v.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Site visits">
        <LoadFailure err={err} what="Site visits" />
      </PageShell>
    );
  }
}
