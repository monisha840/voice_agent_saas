import { api, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createBillingApi, type UsagePage } from "@/lib/billing";
import { ErrorState } from "@/components/StateViews";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { BillingClient } from "./BillingClient";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  try {
    const me = await api.me();
    if (!can(me.organization?.role, "usage:read")) {
      return (
        <PageShell title="Plan & billing">
          <ErrorState title="You don't have permission" message="Only admins and owners can view plan and billing details." />
        </PageShell>
      );
    }
    const billing = createBillingApi(serverHeaders);
    const [overview, plans] = await Promise.all([billing.overview(), billing.plans()]);
    let firstPage: UsagePage | null = null;
    let firstPageError: string | null = null;
    try {
      firstPage = await billing.usage();
    } catch (err) {
      firstPageError = err instanceof Error ? err.message : "Unable to load usage history.";
    }
    return (
      <PageShell title="Plan & billing" subtitle="Your plan, included minutes and call usage. Amounts are in INR.">
        <BillingClient overview={overview} plans={plans} firstPage={firstPage} firstPageError={firstPageError} />
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Plan & billing">
        <LoadFailure err={err} what="Billing" />
      </PageShell>
    );
  }
}
