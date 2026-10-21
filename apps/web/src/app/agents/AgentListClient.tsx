"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Agent } from "@/lib/types";
import { Badge, Card } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

export const TEMPLATE_LABEL: Record<string, string> = {
  generic: "Generic",
  sales_real_estate: "Real estate sales",
};

export function AgentListClient({ agents, canManage }: { agents: Agent[]; canManage: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = agents.filter((a) => showArchived || a.status === "active");
  const archivedCount = agents.filter((a) => a.status === "archived").length;

  return (
    <Card
      title={`${visible.length} agent${visible.length === 1 ? "" : "s"}`}
      action={
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-4 w-4 accent-emerald-700"
            />
            Show archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </label>
          {canManage && (
            <Link
              href="/agents/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              <Plus size={14} />
              New agent
            </Link>
          )}
        </div>
      }
    >
      {visible.length === 0 ? (
        <EmptyState
          title="No agents"
          description={canManage ? "Create your first agent to start making calls." : "No agents have been set up yet."}
        />
      ) : (
        <ul className="-my-2 divide-y divide-stone-100">
          {visible.map((a) => (
            <li key={a.id}>
              <Link href={`/agents/${a.id}`} className="block py-3 text-sm hover:bg-stone-50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium text-stone-900">{a.name}</span>
                    <span className="ml-2 text-stone-500">as {a.personaName}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    {a.isDefault && <Badge tone="success">Default</Badge>}
                    {a.status === "archived" && <Badge tone="warn">Archived</Badge>}
                    <Badge tone="info">{TEMPLATE_LABEL[a.promptTemplateKey] ?? a.promptTemplateKey}</Badge>
                    <span>{a.language}</span>
                    <span>
                      {a.enabledTools.length} tool{a.enabledTools.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                {a.description && <p className="mt-1 line-clamp-2 text-xs text-stone-500">{a.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
