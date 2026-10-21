"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { createKnowledgeApi, type KnowledgeBaseSummary } from "@/lib/knowledge";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

const knowledgeApi = createKnowledgeApi();

export function KnowledgeListClient({ bases, canManage }: { bases: KnowledgeBaseSummary[]; canManage: boolean }) {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = bases.filter((b) => showArchived || b.status === "active");
  const archived = bases.filter((b) => b.status === "archived").length;

  async function create() {
    if (!name.trim()) {
      setError("Give the knowledge base a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const kb = await knowledgeApi.createBase({ name: name.trim(), description: description.trim() || null });
      router.push(`/knowledge/${kb.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {creating && (
        <Card title="New knowledge base">
          <div className="space-y-4">
            <Field label="Name">
              <input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Description" hint="Optional. What this knowledge covers, for your team.">
              <textarea className={inputClass} rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex gap-2">
              <Button busy={busy} onClick={() => void create()}>
                Create
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card
        title={`${visible.length} knowledge base${visible.length === 1 ? "" : "s"}`}
        action={
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4 accent-emerald-700" />
              Show archived{archived > 0 ? ` (${archived})` : ""}
            </label>
            {canManage && !creating && (
              <Button onClick={() => setCreating(true)}>
                <Plus size={14} />
                New knowledge base
              </Button>
            )}
          </div>
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            title="No knowledge yet"
            description={
              canManage
                ? "Create a knowledge base, add FAQs or upload a document, then connect it to an agent."
                : "Ask an admin to add the business information your agents should know."
            }
          />
        ) : (
          <ul className="-my-2 divide-y divide-stone-100">
            {visible.map((b) => (
              <li key={b.id}>
                <Link href={`/knowledge/${b.id}`} className="block py-3 text-sm hover:bg-stone-50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-stone-900">{b.name}</span>
                    <div className="flex items-center gap-2 text-xs text-stone-500">
                      {b.status === "archived" && <Badge tone="warn">Archived</Badge>}
                      <span>
                        {b.itemCount} entr{b.itemCount === 1 ? "y" : "ies"} · {b.documentCount} document{b.documentCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  {b.description && <p className="mt-1 line-clamp-2 text-xs text-stone-500">{b.description}</p>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
