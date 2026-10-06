import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import type { UsageSummary } from "@/lib/types";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { Notice } from "@/components/ui";
import { UsageTiles } from "@/components/UsageTiles";

export default async function UsagePage() {
  try {
    const me = await api.me();
    if (!can(me.organization?.role, "usage:read")) {
      return (
        <PageShell title="Usage">
          <ErrorState title="You don't have permission" message="Only admins and owners can view usage." />
        </PageShell>
      );
    }
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const usage = await api.usageSummary(from.toISOString(), to.toISOString()).catch((): UsageSummary | null => null);
    return (
      <PageShell title="Usage" subtitle="Calls, minutes and AI replies for the last 30 days.">
        {usage ? (
          <UsageTiles usage={usage} showSiteVisits={hasModule(me.organization, "sales")} />
        ) : (
          <Notice tone="info">Usage data is not available right now.</Notice>
        )}
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Usage">
        <LoadFailure err={err} what="Usage" />
      </PageShell>
    );
  }
}
