"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { counterpartyLabel, formatDateTime, formatDuration } from "@/lib/format";
import type { AgentOption, CallListItem, CallStatus, CallType } from "@/lib/types";
import { Button, Card, Notice, errorMessage, inputClass } from "@/components/ui";
import { CallTypeBadge } from "@/components/CallTypeBadge";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { EmptyState } from "@/components/StateViews";

const STATUSES: CallStatus[] = ["initiating", "ringing", "in_progress", "completed", "failed"];
const TYPES: CallType[] = ["outbound", "inbound", "test"];
const PAGE = 25;

type Outcome = "" | "answered" | "unanswered";

/** Local midnight of a YYYY-MM-DD date input (plus `addDays`), as ISO; undefined when empty. */
function dayStart(day: string, addDays = 0): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

export function CallsClient({
  initial,
  initialNext,
  agents,
}: {
  initial: CallListItem[];
  initialNext: string | null;
  agents: AgentOption[];
}) {
  const [calls, setCalls] = useState(initial);
  const [next, setNext] = useState(initialNext);
  const [status, setStatus] = useState<CallStatus | "">("");
  const [agentId, setAgentId] = useState("");
  const [callType, setCallType] = useState<CallType | "">("");
  const [outcome, setOutcome] = useState<Outcome>("");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type Filters = { status: CallStatus | ""; agentId: string; callType: CallType | ""; outcome: Outcome; fromDay: string; toDay: string };

  async function load(f: Filters, before: string | null) {
    setBusy(true);
    setError(null);
    try {
      const page = await api.listCalls({
        limit: PAGE,
        before,
        status: f.status,
        agentId: f.agentId,
        callType: f.callType,
        outcome: f.outcome,
        from: dayStart(f.fromDay),
        to: dayStart(f.toDay, 1),
      });
      setCalls((prev) => (before ? [...prev, ...page.data] : page.data));
      setNext(page.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const filters: Filters = { status, agentId, callType, outcome, fromDay, toDay };
  function change(patch: Partial<Filters>) {
    const nextFilters = { ...filters, ...patch };
    setStatus(nextFilters.status);
    setAgentId(nextFilters.agentId);
    setCallType(nextFilters.callType);
    setOutcome(nextFilters.outcome);
    setFromDay(nextFilters.fromDay);
    setToDay(nextFilters.toDay);
    void load(nextFilters, null);
  }
  const filtered = status || agentId || callType || outcome || fromDay || toDay;

  return (
    <Card
      title="All calls"
      action={
        <div className="flex flex-wrap gap-2">
          {agents.length > 0 && (
            <select
              aria-label="Filter by agent"
              value={agentId}
              disabled={busy}
              onChange={(e) => change({ agentId: e.target.value })}
              className={`${inputClass} w-40`}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Filter by type"
            value={callType}
            disabled={busy}
            onChange={(e) => change({ callType: e.target.value as CallType | "" })}
            className={`${inputClass} w-36 capitalize`}
          >
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            disabled={busy}
            onChange={(e) => change({ status: e.target.value as CallStatus | "" })}
            className={`${inputClass} w-40`}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by outcome"
            value={outcome}
            disabled={busy}
            onChange={(e) => change({ outcome: e.target.value as Outcome })}
            className={`${inputClass} w-40`}
          >
            <option value="">Any outcome</option>
            <option value="answered">Answered</option>
            <option value="unanswered">Not answered</option>
          </select>
        </div>
      }
    >
      <div className="-mt-1 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-stone-500">From</span>
          <input
            type="date"
            value={fromDay}
            max={toDay || undefined}
            disabled={busy}
            onChange={(e) => change({ fromDay: e.target.value })}
            className={`${inputClass} w-40`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-stone-500">To</span>
          <input
            type="date"
            value={toDay}
            min={fromDay || undefined}
            disabled={busy}
            onChange={(e) => change({ toDay: e.target.value })}
            className={`${inputClass} w-40`}
          />
        </label>
        {filtered && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => change({ status: "", agentId: "", callType: "", outcome: "", fromDay: "", toDay: "" })}
          >
            Clear filters
          </Button>
        )}
      </div>
      {calls.length === 0 ? (
        <EmptyState title="No calls" description={filtered ? "No calls match this filter." : "Calls will appear here once an agent makes one."} />
      ) : (
        <ul className="-my-2 divide-y divide-stone-100">
          {calls.map((c) => (
            <li key={c.id}>
              <Link href={`/calls/${c.id}`} className="block py-3 text-sm hover:bg-stone-50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-stone-900">
                    {counterpartyLabel(c)}
                    {c.agentName && <span className="ml-2 font-normal text-stone-500">with {c.agentName}</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-stone-500">
                    <CallTypeBadge type={c.callType} />
                    <CallStatusBadge status={c.status} />
                    <span>{formatDuration(c.startedAt, c.endedAt)}</span>
                    <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
                  </div>
                </div>
                {c.summary && <p className="mt-1 line-clamp-2 text-xs text-stone-500">{c.summary}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {next && (
        <div className="mt-4 text-center">
          <Button variant="secondary" busy={busy} onClick={() => void load(filters, next)}>
            Load more
          </Button>
        </div>
      )}
    </Card>
  );
}
