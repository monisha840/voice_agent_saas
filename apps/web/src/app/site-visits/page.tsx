import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { can } from "@/lib/permissions";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { ModuleDisabled } from "@/components/StateViews";
import { SiteVisitsClient } from "./SiteVisitsClient";

/** Sales module: site visits booked by agents or the team. */
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
    return (
      <PageShell
        title="Site visits"
        subtitle="Visits booked by your agents or team. To book a new visit, open the lead."
      >
        <SiteVisitsClient canManage={can(me.organization?.role, "site-visits:manage")} />
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
