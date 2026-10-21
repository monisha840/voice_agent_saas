import { api } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { can } from "@/lib/permissions";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { ModuleDisabled } from "@/components/StateViews";
import { Card } from "@/components/ui";
import { FollowUpQueue } from "./FollowUpQueue";

/** Sales module: what the agent noted for the team during calls (a person asked for, a callback, a detail to send). */
export default async function FollowUpsPage() {
  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <PageShell title="Follow-ups">
          <ModuleDisabled />
        </PageShell>
      );
    }
    const items = await api.listFollowUps();
    return (
      <PageShell title="Follow-ups" subtitle="Things the agent noted for your team during calls, oldest first.">
        <Card>
          <FollowUpQueue initial={items} canClear={can(me.organization?.role ?? null, "leads:update")} />
        </Card>
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Follow-ups">
        <LoadFailure err={err} what="Follow-ups" />
      </PageShell>
    );
  }
}
