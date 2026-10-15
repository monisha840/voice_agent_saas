"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SiteVisitDetail, SiteVisitView } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { CancelVisitModal, VisitStateBadge, VisitTimeModal, visitState } from "@/components/SiteVisits";
import { Button, Notice, errorMessage } from "@/components/ui";

const PAGE_SIZE = 25;
const TABS: Array<{ view: SiteVisitView; label: string; empty: string }> = [
  { view: "upcoming", label: "Upcoming", empty: "No visits scheduled. Book one from a lead's page, or let your agent book it on a call." },
  { view: "past", label: "Past", empty: "No past visits yet." },
  { view: "cancelled", label: "Cancelled", empty: "No cancelled visits." },
  { view: "all", label: "All", empty: "No site visits yet." },
];

/** Site visits of the leads this user may see, by state, with reschedule and cancel for upcoming ones. */
export function SiteVisitsClient({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<SiteVisitView>("upcoming");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<SiteVisitDetail[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "move" | "cancel"; visit: SiteVisitDetail }>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listSiteVisitsPage({ view, limit: PAGE_SIZE, offset });
      if (mine !== seq.current) return;
      setRows(page.data);
      setTotal(page.total);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [view, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    void load();
  };

  const tab = TABS.find((t) => t.view === view)!;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <section className="rounded-xl border border-stone-200 bg-white">
      <div role="tablist" aria-label="Visit state" className="flex gap-1 overflow-x-auto border-b border-stone-200 px-3 pt-2">
        {TABS.map((t) => (
          <button
            key={t.view}
            role="tab"
            aria-selected={view === t.view}
            onClick={() => {
              setView(t.view);
              setOffset(0);
              setNotice(null);
            }}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              view === t.view ? "border-emerald-700 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="px-5 pt-4">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}

      {error ? (
        <div className="p-5">
          <ErrorState title="Could not load site visits" message={error} onRetry={() => void load()} />
        </div>
      ) : rows === null ? (
        <div className="px-5">
          <LoadingState label="Loading site visits" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title={`No ${tab.label.toLowerCase()} visits`} description={tab.empty} />
        </div>
      ) : (
        <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-400">
              <tr className="border-b border-stone-100">
                <th className="px-5 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Lead</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Project</th>
                <th className="px-3 py-2.5 font-medium">Booking</th>
                {canManage && <th className="px-5 py-2.5 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="whitespace-nowrap px-5 py-3 font-medium text-stone-900">{formatDateTime(v.scheduledAt)}</td>
                  <td className="px-3 py-3">
                    <Link href={`/leads/${v.leadId}`} className="font-medium text-emerald-700 hover:text-emerald-800">
                      {v.leadName}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-stone-500">
                      <span className="tabular-nums">{v.leadPhone}</span>
                      <StatusBadge status={v.leadStatus} />
                    </div>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-700 md:table-cell">
                    <Link href={`/projects/${v.projectId}`} className="hover:text-emerald-800">
                      {v.projectName}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <VisitStateBadge visit={v} />
                  </td>
                  {canManage && (
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      {visitState(v) === "upcoming" ? (
                        <>
                          <Button variant="ghost" onClick={() => setDialog({ kind: "move", visit: v })}>
                            Reschedule
                          </Button>
                          <Button variant="ghost" onClick={() => setDialog({ kind: "cancel", visit: v })}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-stone-400">No changes</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && !error && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 border-t border-stone-200 px-5 py-3 text-sm text-stone-500">
          <span className="tabular-nums">
            {offset + 1}–{last} of {total}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              <ChevronLeft size={14} /> Previous
            </Button>
            <Button variant="secondary" disabled={last >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {dialog?.kind === "move" && (
        <VisitTimeModal
          title={`Reschedule visit for ${dialog.visit.leadName}`}
          submitLabel="Save new time"
          initial={dialog.visit.scheduledAt}
          onClose={() => setDialog(null)}
          onSubmit={async (iso) => {
            await api.rescheduleSiteVisit(dialog.visit.id, iso);
            done(`Visit for ${dialog.visit.leadName} moved to ${formatDateTime(iso)}.`);
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelVisitModal
          when={dialog.visit.scheduledAt}
          who={dialog.visit.leadName}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.cancelSiteVisit(dialog.visit.id);
            done(`Visit for ${dialog.visit.leadName} cancelled.`);
          }}
        />
      )}
    </section>
  );
}
