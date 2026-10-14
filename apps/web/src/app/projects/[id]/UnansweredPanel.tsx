"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { UnansweredQuestion } from "@/lib/types";
import { Card, errorMessage } from "@/components/ui";
import { LoadingState } from "@/components/StateViews";

/** What callers asked about this project that the agent could not answer: the gaps to fill in the knowledge below. */
export function UnansweredPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<UnansweredQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listUnanswered(projectId)
      .then((rows) => !cancelled && setItems(rows))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Card title="Questions we could not answer">
      <p className="mb-3 text-sm text-stone-500">
        Things callers asked about this project that are not in its knowledge. Add them below and the agent can answer next time.
      </p>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {!items && !error && <LoadingState label="Loading…" />}
      {items && items.length === 0 && <p className="text-sm text-stone-500">Nothing yet.</p>}
      {items && items.length > 0 && (
        <ul className="divide-y divide-stone-100">
          {items.slice(0, 20).map((q) => (
            <li key={q.id} className="py-2 text-sm">
              <p className="text-stone-800">{q.note ?? "(no detail recorded)"}</p>
              <p className="text-xs text-stone-400">
                {q.leadId ? (
                  <Link href={`/leads/${q.leadId}`} className="text-emerald-700 hover:text-emerald-800">
                    {q.leadName ?? "Lead"}
                  </Link>
                ) : (
                  (q.leadName ?? "Unknown caller")
                )}{" "}
                · {formatDateTime(q.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
