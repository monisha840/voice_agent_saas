"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { AuditLog } from "@/lib/types";
import { Badge, Button, Card, Notice, errorMessage } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

export function ActivityClient({
  initialLogs,
  initialNext,
}: {
  initialLogs: AuditLog[];
  initialNext: string | null;
}) {
  const [logs, setLogs] = useState(initialLogs);
  const [next, setNext] = useState(initialNext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const page = await api.listAuditLogs({ limit: 50, before: next });
      setLogs((prev) => [...prev, ...page.data]);
      setNext(page.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Audit log">
        {logs.length === 0 ? (
          <EmptyState title="No activity yet" description="Changes made in this organization will appear here." />
        ) : (
          <ul className="-my-2 divide-y divide-stone-100">
            {logs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-stone-900">{l.action}</div>
                  <div className="truncate text-xs text-stone-500">
                    {l.entityType}
                    {l.entityId ? ` · ${l.entityId.slice(0, 8)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-500">
                  <Badge tone={l.actorType === "user" ? "neutral" : "info"}>
                    {l.actorType === "user" ? `user ${l.actorUserId?.slice(0, 8) ?? ""}` : (l.actorSource ?? "system")}
                  </Badge>
                  <time dateTime={l.createdAt}>{new Date(l.createdAt).toLocaleString("en-IN")}</time>
                </div>
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
            <Button variant="secondary" busy={busy} onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
