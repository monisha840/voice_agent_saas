"use client";

import { useRef, useState } from "react";
import { FileText, Search, Trash2, Upload } from "lucide-react";
import {
  createKnowledgeApi,
  fileToBase64,
  formatBytes,
  UPLOAD_ACCEPT,
  type KnowledgeBaseDetail,
  type KnowledgeItem,
  type SearchResult,
} from "@/lib/knowledge";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

const knowledgeApi = createKnowledgeApi();

type Draft = { id: string | null; kind: "faq" | "info"; title: string; body: string };

const DOC_TONE = { ready: "success", processing: "info", failed: "error" } as const;

export function KnowledgeDetailClient({ initial, canManage }: { initial: KnowledgeBaseDetail; canManage: boolean }) {
  const [kb, setKb] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = canManage && kb.status === "active";

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice({ tone: "success", text: msg });
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }
  const reload = async () => setKb(await knowledgeApi.getBase(kb.id));

  async function saveDraft() {
    if (!draft) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      setNotice({ tone: "error", text: draft.kind === "faq" ? "Enter both the question and the answer." : "Enter a topic and the information." });
      return;
    }
    await run("save", async () => {
      if (draft.id) await knowledgeApi.updateItem(kb.id, draft.id, { title: draft.title, body: draft.body });
      else await knowledgeApi.addItem(kb.id, { kind: draft.kind, title: draft.title, body: draft.body });
      setDraft(null);
      await reload();
      return "Saved.";
    });
  }

  async function upload(file: File) {
    await run("upload", async () => {
      const contentBase64 = await fileToBase64(file);
      const doc = await knowledgeApi.uploadDocument(kb.id, { filename: file.name, contentType: file.type || "text/plain", contentBase64 });
      await reload();
      if (doc.status === "failed") throw new Error(`"${doc.filename}" could not be processed: ${doc.error ?? "unknown error"}`);
      return `"${doc.filename}" processed into ${doc.chunkCount} passage${doc.chunkCount === 1 ? "" : "s"}.`;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  const faqs = kb.items.filter((i) => i.kind === "faq");
  const infos = kb.items.filter((i) => i.kind === "info");

  const itemList = (items: KnowledgeItem[], kind: "faq" | "info") =>
    items.length === 0 ? (
      <p className="text-sm text-stone-500">{kind === "faq" ? "No questions yet." : "No information yet."}</p>
    ) : (
      <ul className="divide-y divide-stone-100">
        {items.map((i) => (
          <li key={i.id} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-stone-900">{i.title}</p>
              <p className="mt-0.5 whitespace-pre-line text-sm text-stone-600">{i.body}</p>
            </div>
            {editable && (
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" onClick={() => setDraft({ id: i.id, kind, title: i.title, body: i.body })}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${i.title}`}
                  busy={busy === `del:${i.id}`}
                  onClick={() => {
                    if (window.confirm("Delete this entry?")) {
                      void run(`del:${i.id}`, async () => {
                        await knowledgeApi.deleteItem(kb.id, i.id);
                        await reload();
                        return "Deleted.";
                      });
                    }
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
            {kb.name}
            {kb.status === "archived" && <Badge tone="warn">Archived</Badge>}
          </h1>
          {kb.description && <p className="mt-1 text-sm text-stone-500">{kb.description}</p>}
        </div>
        {canManage && (
          <Button
            variant={kb.status === "active" ? "ghost" : "secondary"}
            busy={busy === "archive"}
            onClick={() =>
              void run("archive", async () => {
                setKb(await knowledgeApi.setArchived(kb.id, kb.status === "active"));
                return kb.status === "active" ? "Archived. Agents no longer search it." : "Restored.";
              })
            }
          >
            {kb.status === "active" ? "Archive" : "Unarchive"}
          </Button>
        )}
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {kb.status === "archived" && <Notice tone="info">This knowledge base is archived: agents do not search it and it is read-only.</Notice>}

      {draft && (
        <Card title={draft.id ? "Edit entry" : draft.kind === "faq" ? "New question" : "New information"}>
          <div className="space-y-4">
            <Field label={draft.kind === "faq" ? "Question" : "Topic"}>
              <input className={inputClass} maxLength={300} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
            </Field>
            <Field label={draft.kind === "faq" ? "Answer" : "Information"} hint="Up to 4,000 characters. Any language (English, Tamil, ...).">
              <textarea className={inputClass} rows={5} maxLength={4000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <Button busy={busy === "save"} onClick={() => void saveDraft()}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title={`FAQs (${faqs.length})`}
          action={editable && !draft ? <Button variant="secondary" onClick={() => setDraft({ id: null, kind: "faq", title: "", body: "" })}>Add question</Button> : undefined}
        >
          {itemList(faqs, "faq")}
        </Card>
        <Card
          title={`Business information (${infos.length})`}
          action={editable && !draft ? <Button variant="secondary" onClick={() => setDraft({ id: null, kind: "info", title: "", body: "" })}>Add information</Button> : undefined}
        >
          {itemList(infos, "info")}
        </Card>
      </div>

      <Card
        title={`Documents (${kb.documents.length})`}
        action={
          editable ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100">
              <Upload size={14} />
              {busy === "upload" ? "Uploading…" : "Upload document"}
              <input
                ref={fileRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                className="sr-only"
                disabled={busy === "upload"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
            </label>
          ) : undefined
        }
      >
        <p className="mb-3 text-xs text-stone-500">
          Text files only (.txt, .md, .csv), up to 200 KB. Documents are split into passages the agent can search. PDF and Word files
          are not supported yet: save them as text first.
        </p>
        {kb.documents.length === 0 ? (
          <EmptyState title="No documents" description="Upload a price list, policy or brochure text to make it searchable." />
        ) : (
          <ul className="divide-y divide-stone-100">
            {kb.documents.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                <div className="flex min-w-0 items-start gap-2">
                  <FileText size={16} className="mt-0.5 shrink-0 text-stone-400" />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-stone-900">{d.filename}</p>
                    <p className="text-xs text-stone-500">
                      {formatBytes(d.sizeBytes)} · {d.status === "ready" ? `${d.chunkCount} passages` : d.status}
                    </p>
                    {d.error && <p className="mt-1 text-xs text-red-700">{d.error}</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={DOC_TONE[d.status]}>{d.status}</Badge>
                  {editable && (
                    <Button
                      variant="ghost"
                      aria-label={`Delete ${d.filename}`}
                      busy={busy === `doc:${d.id}`}
                      onClick={() => {
                        if (window.confirm(`Delete "${d.filename}" and its passages?`)) {
                          void run(`doc:${d.id}`, async () => {
                            await knowledgeApi.deleteDocument(kb.id, d.id);
                            await reload();
                            return "Document deleted.";
                          });
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Try a question">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!query.trim()) return;
            void run("search", async () => {
              setResults((await knowledgeApi.search(kb.id, query.trim())).results);
            });
          }}
        >
          <input
            className={`${inputClass} flex-1`}
            placeholder="What a caller might ask, e.g. Is parking available?"
            value={query}
            maxLength={500}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Test question"
          />
          <Button type="submit" variant="secondary" busy={busy === "search"}>
            <Search size={14} />
            Search
          </Button>
        </form>
        <p className="mt-2 text-xs text-stone-500">Shows exactly what an agent connected to this knowledge base would retrieve for the question.</p>
        {results &&
          (results.length === 0 ? (
            <p className="mt-4 text-sm text-stone-600">Nothing found. The agent would say it will check with the team.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {results.map((r) => (
                <li key={r.id} className="rounded-md border border-stone-200 p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs text-stone-500">
                    <Badge tone="neutral">{r.kind === "faq" ? "FAQ" : r.kind === "info" ? "Information" : "Document"}</Badge>
                  </div>
                  {r.title && <p className="font-medium text-stone-900">{r.title}</p>}
                  <p className="whitespace-pre-line text-stone-700">{r.body}</p>
                </li>
              ))}
            </ol>
          ))}
      </Card>
    </div>
  );
}
