import { api } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { SettingsClient } from "./SettingsClient";
import { SettingsTabs } from "./SettingsTabs";

export default async function SettingsPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role;
    if (!can(role, "audit:read")) {
      return (
        <PageShell title="Settings">
          <ErrorState title="You don't have permission" message="Only admins and owners can view settings." />
        </PageShell>
      );
    }
    const [org, modules] = await Promise.all([api.getOrganization(), api.listModules()]);
    return (
      <PageShell title="Settings" subtitle="Organization settings and optional modules.">
        <SettingsTabs active="general" />
        <SettingsClient initialName={org.name} initialModules={modules} canManage={can(role, "org:manage")} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Settings">
        <LoadFailure err={err} what="Settings" />
      </PageShell>
    );
  }
}
