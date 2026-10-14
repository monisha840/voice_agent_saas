"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { FollowUp, FollowUpKind } from "@/lib/types";
import { Badge, Button, errorMessage } from "@/components/ui";

const KIND: Record<FollowUpKind, { label: string; tone: "warn" | "info" | "error" | "neutral" }> = {
  human_requested: { label: "Asked for a person", tone: "warn" },
  callback: { label: "Call back", tone: "info" },
  info_requested: { label: "Needs information", tone: "neutral" },
  do_not_call: { label: "Do not call", tone: "error" },
  preference: { label: "Wants something else", tone: "info" },
};

/** A follow-up, optionally with who it concerns (the team queue shows that; a lead's own page does not need it). */
export type FollowUpItem = Omit<FollowUp, "resolvedAt"> & {
  resolvedAt?: string | null;
  leadName?: string | null;
  leadPhone?: string | null;
  callerName?: string | null;
  callerPhone?: string | null;
};

/**
 * Follow-ups the agent noted for the team. Open ones can be marked done by anyone allowed to edit leads; done ones stay
 * visible (greyed) in a lead's own history.
 */
export function FollowUpList({
  items,
  canClear,
  onCleared,
}: {
  items: FollowUpItem[];
  canClear: boolean;
  onCleared?: (id: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function clear(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.completeFollowUp(id);
      onCleared?.(id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <ul className="divide-y divide-stone-100">
        {items.map((f) => {
          const kind = KIND[f.kind] ?? { label: f.kind, tone: "neutral" as const };
          const done = f.status === "done";
          const name = f.leadName ?? f.callerName;
          const phone = f.leadPhone ?? f.callerPhone;
          return (
            <li key={f.id} className={`flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0 ${done ? "opacity-60" : ""}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={done ? "neutral" : kind.tone}>{kind.label}</Badge>
                  {(name || phone) && (
                    <span className="text-sm font-medium text-stone-900">
                      {f.leadId ? (
                        <Link href={`/leads/${f.leadId}`} className="text-emerald-700 hover:text-emerald-800">
                          {name ?? phone}
                        </Link>
                      ) : (
                        (name ?? phone)
                      )}
                      {name && phone ? <span className="ml-2 font-normal text-stone-500">{phone}</span> : null}
                    </span>
                  )}
                </div>
                {f.note && <p className="text-sm text-stone-700">{f.note}</p>}
                <p className="text-xs text-stone-400">
                  {f.dueAt ? `Asked for ${formatDateTime(f.dueAt)} · ` : ""}
                  Noted {formatDateTime(f.createdAt)}
                  {done ? " · done" : ""}
                </p>
              </div>
              {!done && canClear && (
                <Button variant="secondary" busy={busyId === f.id} onClick={() => void clear(f.id)}>
                  Mark done
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
