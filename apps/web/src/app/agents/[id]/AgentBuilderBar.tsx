"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BookOpen, Copy, MessageSquare } from "lucide-react";
import { createKnowledgeApi, type KnowledgeBaseSummary } from "@/lib/knowledge";
import { Button, Card, Notice, errorMessage } from "@/components/ui";

const knowledgeApi = createKnowledgeApi();

/**
 * Agent-builder actions next to the editor: test in the playground, duplicate, and which knowledge bases the agent
 * may search. Knowledge-base bindings are saved through their own endpoint, so the editor's own save never drops them.
 */
export function AgentBuilderBar({
  agentId,
  active,
  canManage,
  canTest,
  bases,
  boundIds,
}: {
  agentId: string;
  active: boolean;
  canManage: boolean;
  canTest: boolean;
  bases: KnowledgeBaseSummary[] | null;
  boundIds: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(boundIds);
  const [saved, setSaved] = useState<string[]>(boundIds);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const activeBases = (bases ?? []).filter((b) => b.status === "active");
  const dirty = [...selected].sort().join() !== [...saved].sort().join();

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: "success", text: await fn() });
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-wrap gap-2">
        {canTest && active && (
          <Link
            href={`/agents/${agentId}/playground`}
            className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            <MessageSquare size={14} />
            Test in playground
          </Link>
        )}
        {canManage && (
          <Button
            variant="secondary"
            busy={busy === "dup"}
            onClick={() =>
              void run("dup", async () => {
                const copy = await knowledgeApi.duplicateAgent(agentId);
                router.push(`/agents/${copy.id}`);
                return `Created "${copy.name}".`;
              })
            }
          >
            <Copy size={14} />
            Duplicate
          </Button>
        )}
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Card
        title="Knowledge base"
        action={
          <Link href="/knowledge" className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800">
            <BookOpen size={14} />
            Manage knowledge
          </Link>
        }
      >
        {bases === null ? (
          <Notice tone="info">The knowledge bases could not be loaded.</Notice>
        ) : activeBases.length === 0 ? (
          <p className="text-sm text-stone-500">No knowledge bases yet. Create one with FAQs or documents, then connect it here.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-stone-500">
              The agent searches the selected knowledge during a conversation (tool <span className="font-mono text-xs">search_knowledge</span>,
              enabled automatically).
            </p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {activeBases.map((b) => (
                <li key={b.id}>
                  <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={!canManage || !active}
                      checked={selected.includes(b.id)}
                      onChange={() => setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
                      className="mt-0.5 h-4 w-4 accent-emerald-700"
                    />
                    <span>
                      <span className="block font-medium text-stone-900">{b.name}</span>
                      <span className="block text-xs text-stone-500">
                        {b.itemCount} entries · {b.documentCount} documents
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {canManage && active && (
              <Button
                disabled={!dirty}
                busy={busy === "kb"}
                onClick={() =>
                  void run("kb", async () => {
                    const r = await knowledgeApi.setAgentKnowledgeBases(agentId, selected);
                    setSaved(r.knowledgeBaseIds);
                    // Full reload: the editor below keeps its own copy of the tool list, which this changed.
                    window.location.reload();
                    return r.knowledgeBaseIds.length > 0 ? "Knowledge connected." : "Knowledge disconnected.";
                  })
                }
              >
                Save knowledge
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
