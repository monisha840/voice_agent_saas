import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { SettingsTabs } from "../SettingsTabs";
import { ActivityClient } from "./ActivityClient";

export default async function ActivityPage() {
  try {
    const me = await api.me();
    if (!can(me.organization?.role, "audit:read")) {
      return (
        <PageShell title="Settings">
          <ErrorState title="You don't have permission" message="Only admins and owners can view activity." />
        </PageShell>
      );
    }
    const logs = await api.listAuditLogs({ limit: 50 });
    return (
      <PageShell title="Settings" subtitle="Audit log of changes in this organization.">
        <SettingsTabs active="activity" />
        <ActivityClient initialLogs={logs.data} initialNext={logs.nextBefore} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Settings">
        <LoadFailure err={err} what="Activity" />
      </PageShell>
    );
  }
}
