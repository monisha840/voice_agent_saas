"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { KnowledgeCategory, KnowledgeDraft } from "@/lib/types";
import { Badge, Button, Card, Notice, errorMessage, inputClass } from "@/components/ui";

const LABEL: Record<string, string> = {
  pricing: "Pricing",
  configurations: "Configurations",
  amenities: "Amenities",
  possession: "Possession",
  location: "Location",
  faq: "FAQ",
  rera: "RERA",
  loan: "Home loan",
  booking: "Booking",
  maintenance: "Maintenance",
  nearby: "Nearby places",
  approvals: "Approvals",
  builder: "Builder",
  about: "About the project",
};

/**
 * Paste a brochure, price sheet or FAQ and get a DRAFT of the structured knowledge. Nothing is saved until a person
 * approves a category, and a category that already has content is replaced only when approved here.
 */
export function KnowledgeDraftPanel({ projectId, existing }: { projectId: string; existing: KnowledgeCategory[] }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [savingCategory, setSavingCategory] = useState<string | null>(null);

  async function createDraft() {
    setBusy(true);
    setError(null);
    setDraft(null);
    setSaved(new Set());
    try {
      setDraft(await api.draftKnowledge(projectId, text));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve(category: KnowledgeCategory) {
    if (!draft) return;
    setSavingCategory(category);
    setError(null);
    try {
      await api.saveKnowledge(projectId, category, draft.drafts[category]);
      setSaved((prev) => new Set(prev).add(category));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingCategory(null);
    }
  }

  const proposed = draft ? (Object.keys(draft.drafts) as KnowledgeCategory[]) : [];

  return (
    <Card title="Fill from a brochure or price sheet">
      <p className="mb-3 text-sm text-stone-500">
        Paste the text of a brochure, price sheet or FAQ. The assistant proposes entries from what is written; you review and
        approve each one. Nothing is saved until you approve it, and numbers it cannot find are left out.
      </p>
      <textarea
        rows={6}
        value={text}
        maxLength={20000}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste the brochure text here…"
        className={inputClass}
      />
      <div className="mt-3">
        <Button busy={busy} disabled={text.trim().length < 20} onClick={() => void createDraft()}>
          Create draft
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {draft && proposed.length === 0 && draft.rejected.length === 0 && (
        <div className="mt-4">
          <Notice tone="info">No facts could be found in that text.</Notice>
        </div>
      )}

      {proposed.length > 0 && (
        <ul className="mt-4 space-y-3">
          {proposed.map((c) => (
            <li key={c} className="rounded-lg border border-stone-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-stone-900">
                  {LABEL[c] ?? c}
                  {existing.includes(c) && !saved.has(c) && <Badge tone="warn">Replaces what is saved</Badge>}
                  {saved.has(c) && <Badge tone="success">Saved</Badge>}
                </div>
                {!saved.has(c) && (
                  <Button variant="secondary" busy={savingCategory === c} onClick={() => void approve(c)}>
                    Approve and save
                  </Button>
                )}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 text-xs text-stone-700">
                {JSON.stringify(draft!.drafts[c], null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}

      {draft && draft.rejected.length > 0 && (
        <div className="mt-4 text-sm text-stone-600">
          <p className="font-medium text-stone-800">Not usable as written</p>
          <ul className="mt-1 list-disc pl-5">
            {draft.rejected.map((r) => (
              <li key={r.category}>
                {LABEL[r.category] ?? r.category}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {saved.size > 0 && <p className="mt-3 text-xs text-stone-500">Reload this page to see saved entries in the forms below.</p>}
    </Card>
  );
}
