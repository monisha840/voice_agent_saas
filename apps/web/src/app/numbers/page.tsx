import { api, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createNumbersApi } from "@/lib/numbers";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { NumbersClient } from "./NumbersClient";

export const dynamic = "force-dynamic";

export default async function NumbersPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role;
    if (!can(role, "agents:read")) {
      return (
        <PageShell title="Phone numbers">
          <ErrorState title="You don't have permission" message="Only managers, admins and owners can view phone numbers." />
        </PageShell>
      );
    }
    const [data, agents] = await Promise.all([createNumbersApi(serverHeaders).list(), api.listAgents(false)]);
    return (
      <PageShell title="Phone numbers" subtitle="Which agent answers each of your numbers, and how calls to them are going.">
        <NumbersClient
          provider={data.provider}
          numbers={data.numbers}
          agents={agents.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))}
          canManage={can(role, "agents:manage")}
        />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Phone numbers">
        <LoadFailure err={err} what="Phone numbers" />
      </PageShell>
    );
  }
}
