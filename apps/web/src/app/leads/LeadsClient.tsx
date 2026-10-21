"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { api } from "@/lib/api";
import { formatBudgetRange, formatRelativeActivity } from "@/lib/format";
import type { Lead, LeadStatus, Project } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { Button, errorMessage, inputClass } from "@/components/ui";
import { LEADS_CHANGED_EVENT } from "../NewLeadButton";

const PAGE_SIZE = 25;

export const LEAD_STATUSES: LeadStatus[] = [
  "NEW",
  "CALLING",
  "NO_ANSWER",
  "BUSY",
  "RETRY",
  "ANSWERED",
  "QUALIFICATION",
  "INTERESTED",
  "NOT_INTERESTED",
  "DNC",
  "VISIT_OFFERED",
  "VISIT_BOOKED",
  "CONFIRMED",
  "VISITED",
  "NO_SHOW",
  "FOLLOW_UP",
];

export const statusLabel = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

/** Searchable, filterable, paged list of the leads this user may see (scope is decided by the API). */
export function LeadsClient({ projects, headerAction }: { projects: Project[]; headerAction?: React.ReactNode }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // debounced
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter change goes back to the first page.
  useEffect(() => setOffset(0), [query, status, projectId]);

  const load = useCallback(async () => {
    const mine = ++seq.current; // ignore responses that arrive after a newer request
    setLoading(true);
    setError(null);
    try {
      const page = await api.listLeadsPage({ q: query || undefined, status: status || undefined, projectId: projectId || undefined, limit: PAGE_SIZE, offset });
      if (mine !== seq.current) return;
      setRows(page.data);
      setTotal(page.total);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query, status, projectId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // A lead created from New lead appears without a full reload.
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener(LEADS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(LEADS_CHANGED_EVENT, reload);
  }, [load]);

  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const filtered = Boolean(query || status || projectId);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <section className="rounded-xl border border-stone-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 px-4 py-3 sm:px-5">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search leads</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or phone"
            className={`${inputClass} pl-8`}
            maxLength={100}
          />
        </label>
        <label className="w-full sm:w-44">
          <span className="sr-only">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {projects.length > 1 && (
          <label className="w-full sm:w-48">
            <span className="sr-only">Project</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {headerAction && <div className="ml-auto">{headerAction}</div>}
      </div>

      {error ? (
        <div className="p-5">
          <ErrorState title="Could not load leads" message={error} onRetry={() => void load()} />
        </div>
      ) : rows === null ? (
        <div className="px-5">
          <LoadingState label="Loading leads" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title={filtered ? "No leads match" : "No leads yet"}
            description={filtered ? "Try a different search or filter." : "Add your first lead with New lead."}
          />
        </div>
      ) : (
        <div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-400">
              <tr className="border-b border-stone-100">
                <th className="px-4 py-2.5 font-medium sm:px-5">Lead</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Requirement</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Project</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Assigned</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell sm:px-5">Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((lead) => (
                <tr key={lead.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3 sm:px-5">
                    <Link href={`/leads/${lead.id}`} className="font-medium text-stone-900 hover:text-emerald-800">
                      {lead.name}
                    </Link>
                    <div className="text-xs tabular-nums text-stone-500">{lead.phone}</div>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-700 md:table-cell">
                    {lead.requirementConfig ?? <span className="text-stone-400">Not captured</span>}
                    <div className="text-xs text-stone-500">{formatBudgetRange(lead.budgetMin, lead.budgetMax)}</div>
                  </td>
                  <td className="hidden px-3 py-3 text-stone-700 lg:table-cell">{projectName.get(lead.projectId) ?? "—"}</td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    {lead.assigneeName ?? <span className="text-stone-400">Unassigned</span>}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={lead.status} />
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-stone-500 sm:table-cell sm:px-5">
                    {formatRelativeActivity(lead.status, lead.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && !error && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 px-4 py-3 text-sm text-stone-500 sm:px-5">
          <span className="tabular-nums">
            {first}–{last} of {total}
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
    </section>
  );
}
