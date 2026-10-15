import { ApiError, apiBase } from "./api";

/** Client for the knowledge base, agent duplication and the agent test playground. */

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  itemCount: number;
  documentCount: number;
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  kind: "faq" | "info";
  title: string;
  body: string;
  position: number;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed";
  error: string | null;
  chunkCount: number;
  createdAt: string;
}

export interface KnowledgeBaseDetail {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  updatedAt: string;
  items: KnowledgeItem[];
  documents: KnowledgeDocument[];
}

export interface SearchResult {
  id: string;
  knowledgeBase: string;
  kind: "faq" | "info" | "document";
  title: string;
  body: string;
  rank: number;
}

export type PlaygroundEvent =
  | { type: "agent"; text: string; endsCall: boolean }
  | { type: "caller"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "ended"; reason: string };

export interface PlaygroundStart {
  sessionId: string;
  simulated: true;
  agent: { id: string; name: string; personaName: string; language: string };
  effectiveTools: string[];
  events: PlaygroundEvent[];
  ended: boolean;
}

export const MAX_UPLOAD_BYTES = 200 * 1024;
export const UPLOAD_ACCEPT = ".txt,.md,.csv,text/plain,text/markdown,text/csv";

export function createKnowledgeApi(getHeaders: () => Promise<Record<string, string>> | Record<string, string> = () => ({})) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const extra = await getHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string; code?: string };
    if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status, json.code);
    return json.data as T;
  }
  return {
    listBases: (includeArchived = false) =>
      call<KnowledgeBaseSummary[]>("GET", `/api/knowledge-bases${includeArchived ? "?includeArchived=true" : ""}`),
    getBase: (id: string) => call<KnowledgeBaseDetail>("GET", `/api/knowledge-bases/${id}`),
    createBase: (input: { name: string; description?: string | null }) => call<KnowledgeBaseDetail>("POST", "/api/knowledge-bases", input),
    updateBase: (id: string, input: { name?: string; description?: string | null }) =>
      call<KnowledgeBaseDetail>("PATCH", `/api/knowledge-bases/${id}`, input),
    setArchived: (id: string, archived: boolean) =>
      call<KnowledgeBaseDetail>("POST", `/api/knowledge-bases/${id}/${archived ? "archive" : "unarchive"}`, {}),
    addItem: (id: string, input: { kind: "faq" | "info"; title: string; body: string }) =>
      call<KnowledgeItem>("POST", `/api/knowledge-bases/${id}/items`, input),
    updateItem: (id: string, itemId: string, input: { title?: string; body?: string }) =>
      call<KnowledgeItem>("PATCH", `/api/knowledge-bases/${id}/items/${itemId}`, input),
    deleteItem: (id: string, itemId: string) => call<{ deleted: boolean }>("DELETE", `/api/knowledge-bases/${id}/items/${itemId}`),
    uploadDocument: (id: string, input: { filename: string; contentType: string; contentBase64: string }) =>
      call<KnowledgeDocument>("POST", `/api/knowledge-bases/${id}/documents`, input),
    deleteDocument: (id: string, documentId: string) =>
      call<{ deleted: boolean }>("DELETE", `/api/knowledge-bases/${id}/documents/${documentId}`),
    search: (id: string, query: string) =>
      call<{ query: string; terms: string[]; results: SearchResult[] }>("POST", `/api/knowledge-bases/${id}/search`, { query }),
    setAgentKnowledgeBases: (agentId: string, knowledgeBaseIds: string[]) =>
      call<{ agentId: string; knowledgeBaseIds: string[]; searchToolEnabled: boolean }>("PUT", `/api/agents/${agentId}/knowledge-bases`, {
        knowledgeBaseIds,
      }),
    duplicateAgent: (agentId: string) => call<{ id: string; name: string }>("POST", `/api/agents/${agentId}/duplicate`, {}),
    startPlayground: (agentId: string) => call<PlaygroundStart>("POST", `/api/agents/${agentId}/playground`, {}),
    sendPlayground: (sessionId: string, text: string) =>
      call<{ sessionId: string; events: PlaygroundEvent[]; ended: boolean }>("POST", `/api/playground/${sessionId}/messages`, { text }),
    endPlayground: (sessionId: string) => call<{ ended: boolean }>("DELETE", `/api/playground/${sessionId}`),
  };
}

/** Reads a File as base64 (without the data: prefix), refusing files over the server's limit before uploading. */
export function fileToBase64(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new Error(`The file is larger than ${MAX_UPLOAD_BYTES / 1024} KB`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
}
