"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createBillingApi,
  formatClock,
  formatDate,
  formatDateTimeIst,
  formatInr,
  REASON_LABEL,
  STATUS_LABEL,
  type BillingOverview,
  type Plan,
  type UsageEntry,
} from "@/lib/billing";
import { Badge, Button, Card, errorMessage, Notice } from "@/components/ui";
import { EmptyState, ErrorState } from "@/components/StateViews";

const billingApi = createBillingApi();

const SALES_EMAIL = "support@sirahdigital.in";

const TONE: Record<string, "success" | "warn" | "error" | "neutral"> = {
  trialing: "neutral",
  active: "success",
  past_due: "warn",
  suspended: "error",
  canceled: "error",
  expired: "error",
};

/** Plan and usage overview. Server data in, owner actions out; every state (empty, error, retry) is explicit. */
export function BillingClient({
  overview,
  plans,
  firstPage,
  firstPageError,
}: {
  overview: BillingOverview;
  plans: Plan[];
  firstPage: { data: UsageEntry[]; nextCursor: string | null } | null;
  firstPageError: string | null;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<UsageEntry[]>(firstPage?.data ?? []);
  const [cursor, setCursor] = useState<string | null>(firstPage?.nextCursor ?? null);
  const [historyError, setHistoryError] = useState<string | null>(firstPageError);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const run = useCallback(
    async (key: string, fn: () => Promise<string | void>) => {
      setBusy(key);
      setNotice(null);
      try {
        const text = await fn();
        if (text) setNotice({ tone: "success", text });
        router.refresh();
      } catch (err) {
        setNotice({ tone: "error", text: errorMessage(err) });
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const page = await billingApi.usage(cursor ?? undefined);
      setEntries((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function retryFirstPage() {
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const page = await billingApi.usage();
      setEntries(page.data);
      setCursor(page.nextCursor);
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const u = overview.usage;
  const pct = u.includedMinutes > 0 ? Math.min(100, Math.round((u.usedMinutes / u.includedMinutes) * 100)) : 0;
  const nearLimit = overview.managed && overview.allowed && u.includedMinutes > 0 && pct >= 80;
  const plan = overview.plan;
  const mailto = (subject: string) => `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}`;

  return (
    <div className="space-y-6">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {/* Blocking / warning state first: the thing the owner must act on. */}
      {overview.managed && !overview.allowed && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">Calls are paused</p>
          <p className="mt-1">{overview.message}</p>
          {overview.nextStep === "contact_sales" || overview.nextStep === "upgrade" ? (
            <a className="mt-2 inline-block font-medium underline" href={mailto("Plan upgrade request")}>
              Contact sales
            </a>
          ) : null}
        </div>
      )}
      {nearLimit && (
        <Notice tone="info">
          You have used {pct}% of this period&apos;s included minutes ({u.remainingMinutes.toLocaleString("en-IN")} minutes left).
        </Notice>
      )}
      {overview.managed && overview.status === "past_due" && (
        <Notice tone="info">A payment is outstanding. Calls continue for now; resolve it to avoid suspension.</Notice>
      )}

      <Card title="Current plan">
        {!overview.managed ? (
          <div className="space-y-3">
            <p className="text-sm text-stone-700">
              This workspace is not on a managed plan yet, so platform default limits apply. Start a trial to get a plan with a
              defined minute allowance and call limits.
            </p>
            {overview.canManage ? (
              <Button busy={busy === "trial"} onClick={() => run("trial", async () => { await billingApi.startTrial(); return "Trial started."; })}>
                Start free trial
              </Button>
            ) : (
              <p className="text-sm text-stone-500">Ask a workspace owner to start a trial.</p>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold text-stone-900">{plan?.name ?? "Unknown plan"}</span>
              {overview.status && <Badge tone={TONE[overview.status] ?? "neutral"}>{STATUS_LABEL[overview.status]}</Badge>}
              {overview.cancelAtPeriodEnd && <Badge tone="warn">Ends {formatDate(overview.periodEnd)}</Badge>}
            </div>
            <dl className="grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
              <div>
                <dt className="text-stone-500">Price</dt>
                <dd className="mt-0.5 font-medium text-stone-900">
                  {plan ? `${formatInr(plan.pricePaise)}${plan.pricePaise ? ` / ${plan.billingInterval}` : ""}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">{overview.status === "trialing" ? "Trial ends" : "Current period"}</dt>
                <dd className="mt-0.5 font-medium text-stone-900">
                  {overview.status === "trialing"
                    ? formatDate(overview.trialEndsAt)
                    : `${formatDate(overview.periodStart)} – ${formatDate(overview.periodEnd)}`}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Concurrent calls</dt>
                <dd className="mt-0.5 font-medium text-stone-900">{overview.limits.maxConcurrentCalls ?? "—"}</dd>
              </div>
            </dl>

            <div>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-stone-900">
                  {u.usedMinutes.toLocaleString("en-IN")} of {u.includedMinutes.toLocaleString("en-IN")} minutes used
                </span>
                <span className="text-stone-500">{u.remainingMinutes.toLocaleString("en-IN")} remaining</span>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={u.includedMinutes}
                aria-valuenow={Math.min(u.usedMinutes, u.includedMinutes)}
                aria-label="Included minutes used"
              >
                <div className={`h-full ${pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-emerald-700"}`} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Each call is rounded up to the next minute. Unanswered calls, calls under a few seconds and test calls are not
                billed.
              </p>
              {u.pendingEntries > 0 && (
                <p className="mt-1 text-xs text-stone-500">
                  {u.pendingEntries} interrupted call{u.pendingEntries === 1 ? "" : "s"} awaiting an end time are not counted yet.
                </p>
              )}
            </div>

            {overview.canManage && (
              <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-4">
                {overview.cancelAtPeriodEnd ? (
                  <Button variant="secondary" busy={busy === "resume"} onClick={() => run("resume", async () => { await billingApi.resume(); return "Cancellation withdrawn."; })}>
                    Keep my plan
                  </Button>
                ) : confirmCancel ? (
                  <>
                    <span className="self-center text-sm text-stone-700">Cancel at the end of the current period?</span>
                    <Button variant="danger" busy={busy === "cancel"} onClick={() => run("cancel", async () => { await billingApi.cancel(); setConfirmCancel(false); return "Your plan will end at the close of the period."; })}>
                      Yes, cancel
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep plan</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmCancel(true)}>Cancel plan</Button>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Plans">
        <p className="mb-4 text-sm text-stone-500">
          Prices are per month in INR, excluding taxes. Online payment is not enabled yet: choosing a plan sends a request to our
          team, which activates it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const current = plan?.key === p.key;
            const requested = overview.scheduledPlanKey === p.key;
            return (
              <div key={p.key} className={`rounded-lg border p-4 ${current ? "border-emerald-600 bg-emerald-50/40" : "border-stone-200"}`}>
                <div className="text-sm font-semibold text-stone-900">{p.name}</div>
                <div className="mt-1 text-lg font-semibold text-stone-900">{formatInr(p.pricePaise)}</div>
                <ul className="mt-3 space-y-1 text-xs text-stone-600">
                  {p.pricePaise !== null && <li>{p.includedMinutes.toLocaleString("en-IN")} minutes included</li>}
                  {p.entitlements.maxConcurrentCalls !== undefined && <li>{p.entitlements.maxConcurrentCalls} concurrent calls</li>}
                  {p.entitlements.maxAgents !== undefined && <li>{p.entitlements.maxAgents} agents</li>}
                  {p.entitlements.maxTeamMembers !== undefined && <li>{p.entitlements.maxTeamMembers} team members</li>}
                  {p.pricePaise === null && <li>Negotiated limits and pricing</li>}
                </ul>
                <div className="mt-4">
                  {current ? (
                    <Badge tone="success">Current plan</Badge>
                  ) : p.pricePaise === null ? (
                    <a className="text-sm font-medium text-emerald-700 hover:text-emerald-800" href={mailto("Enterprise plan enquiry")}>
                      Contact sales
                    </a>
                  ) : requested ? (
                    <Badge tone="neutral">Requested</Badge>
                  ) : overview.canManage && overview.managed ? (
                    <Button
                      variant="secondary"
                      busy={busy === `plan:${p.key}`}
                      onClick={() => run(`plan:${p.key}`, async () => (await billingApi.requestPlanChange(p.key)).message)}
                    >
                      Request {p.name}
                    </Button>
                  ) : (
                    <span className="text-xs text-stone-500">{overview.managed ? "Owner only" : "Start a trial first"}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Call usage">
        {historyError && entries.length === 0 ? (
          <ErrorState title="Unable to load usage" message={historyError} onRetry={retryFirstPage} />
        ) : entries.length === 0 ? (
          <EmptyState title="No billed calls yet" description="Completed calls appear here with their duration and billable minutes." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Call usage history</caption>
                <thead className="text-xs uppercase tracking-wide text-stone-400">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-medium">When</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Outcome</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Duration</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Billed minutes</th>
                    <th scope="col" className="py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 pr-4 text-stone-700">{formatDateTimeIst(e.occurredAt)}</td>
                      <td className="py-2 pr-4 capitalize text-stone-700">{e.outcome}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-stone-700">{formatClock(e.durationSeconds)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium text-stone-900">{e.billableMinutes}</td>
                      <td className="py-2 text-stone-500">
                        {REASON_LABEL[e.billableReason] ?? e.billableReason}
                        {e.state === "pending" ? " (pending)" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {historyError && <p className="mt-3 text-sm text-red-700">{historyError}</p>}
            {cursor && (
              <div className="mt-4">
                <Button variant="secondary" busy={loadingMore} onClick={loadMore}>
                  {historyError ? "Retry" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
