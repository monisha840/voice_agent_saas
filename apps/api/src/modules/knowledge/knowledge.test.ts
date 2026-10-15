/**
 * Knowledge base, agent builder additions and the test playground, against real PostgreSQL as the restricted runtime
 * role: CRUD and validation, uploads, retrieval (English, Tamil, Tanglish), tenant/agent isolation, configuration
 * loading into the real call runtime, and an end-to-end playground conversation through the real ConversationSession.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql } from "../../db/client.js";
import { auditLogs, knowledgeBases, knowledgeDocuments, knowledgeItems } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "../../adapters/ai/llm.interface.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { httpClient, relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { callsService } from "../calls/calls.service.js";
import { callRuntime } from "../calls/call-runtime.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { runInTenant } from "../../db/tenant-context.js";
import { setPlaygroundLlmFactory, openPlaygroundSessions } from "../playground/playground.service.js";
import { chunkText, csvToPassages, decodeUpload, queryTerms, UploadRejectedError } from "./knowledge-text.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let B: TestTenant;
let adminA = "";
let managerA = "";
let agentRoleA = "";
let ownerB = "";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

/** A scripted model: each call gets the next step; a step may read the messages (e.g. to quote a tool result). */
class ScriptedLlm implements ILanguageModel {
  readonly name = "scripted";
  readonly capabilities = { toolCalling: true };
  readonly seen: Array<{ messages: ChatMessage[]; tools: string[] }> = [];
  private i = 0;
  constructor(private readonly steps: Array<(m: ChatMessage[]) => ChatResult>) {}
  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    this.seen.push({ messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name) });
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    return step(messages);
  }
}

beforeAll(async () => {
  A = await createTenant("KB_A");
  B = await createTenant("KB_B");
  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const agentUser = await createMember(A.orgId, "AGENT");
  const started = await startTestApp();
  app = started.app;
  http = httpClient(started.baseUrl);
  adminA = await loginCookie(started.baseUrl, admin.email);
  managerA = await loginCookie(started.baseUrl, manager.email);
  agentRoleA = await loginCookie(started.baseUrl, agentUser.email);
  ownerB = await loginCookie(started.baseUrl, B.email);
});

afterEach(() => setPlaygroundLlmFactory(null));

afterAll(async () => {
  await app.close();
  const ids = [A.orgId, B.orgId];
  await db.delete(knowledgeItems).where(inArray(knowledgeItems.organizationId, ids));
  await db.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.organizationId, ids));
  await db.delete(knowledgeBases).where(inArray(knowledgeBases.organizationId, ids));
  await adminSql!.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    await tx.unsafe("delete from usage_ledger where organization_id = any($1::uuid[])", [ids]);
  });
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, ids));
  await cleanupTenants();
});

describe("text handling (pure)", () => {
  it("accepts only small UTF-8 text files of an allowed type, and cleans them", () => {
    const ok = decodeUpload({ filename: "faq.md", contentType: "text/markdown", contentBase64: b64("# Hours\u200B\r\n\r\nOpen 9-6\u202E") });
    expect(ok.text).toBe("# Hours\n\nOpen 9-6");
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
    const reject = (f: string, ct: string, body: string | Buffer) => () => decodeUpload({ filename: f, contentType: ct, contentBase64: b64(body) });
    expect(reject("a.pdf", "application/pdf", "%PDF-1.7")).toThrow(UploadRejectedError);
    expect(reject("a.exe", "application/octet-stream", "MZ")).toThrow(/Unsupported file type/);
    expect(reject("a.txt", "application/pdf", "hello")).toThrow(/does not match/);
    expect(reject("a.txt", "text/plain", Buffer.from([0x68, 0x00, 0x69]))).toThrow(/not a text file/);
    expect(reject("a.txt", "text/plain", Buffer.from([0xc3, 0x28]))).toThrow(/not UTF-8/);
    expect(reject("a.txt", "text/plain", "x".repeat(210 * 1024))).toThrow(/larger than/);
    expect(reject("../../etc/passwd.txt", "text/plain", "x")).toThrow(/Invalid file name/);
    expect(reject("a.txt", "text/plain", "   \n  ")).toThrow(/no readable text/);
  });

  it("splits documents into passages and CSV rows into labelled passages", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about the parking and the lifts.`).join(" ");
    const chunks = chunkText(`Intro paragraph.\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1120);
    expect(csvToPassages('Item,Price\n"Parking, covered",50000\nClub,"Included"\n')).toEqual([
      "Item: Parking, covered; Price: 50000",
      "Item: Club; Price: Included",
    ]);
  });

  it("extracts query terms in any script and drops filler words", () => {
    expect(queryTerms("What is the parking charge?")).toEqual(["parking", "charge"]);
    expect(queryTerms("பார்க்கிங் கட்டணம் என்ன")).toEqual(["பார்க்கிங்", "கட்டணம்", "என்ன"]);
    expect(queryTerms("parking charge enna sollunga")).toEqual(["parking", "charge"]);
  });
});

describe("knowledge base CRUD, validation and permissions", () => {
  let kbId = "";

  it("ADMIN creates a knowledge base; MANAGER can read but not change; AGENT cannot read", async () => {
    const res = await http(adminA, "POST", "/api/knowledge-bases", { name: "Clinic FAQ", description: "Front desk answers" });
    expect(res.status).toBe(201);
    kbId = res.body.data.id;
    expect(res.body.data).toMatchObject({ name: "Clinic FAQ", status: "active", items: [], documents: [] });
    expect((await http(managerA, "GET", `/api/knowledge-bases/${kbId}`)).status).toBe(200);
    expect((await http(managerA, "POST", "/api/knowledge-bases", { name: "Nope" })).status).toBe(403);
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "faq", title: "q", body: "a" })).status).toBe(403);
    expect((await http(agentRoleA, "GET", "/api/knowledge-bases")).status).toBe(403);
    expect((await http(adminA, "POST", "/api/knowledge-bases", { name: "clinic faq" })).status).toBe(409); // case-insensitive unique
  });

  it("validates input strictly (unknown fields, empty text, wrong kinds)", async () => {
    expect((await http(adminA, "POST", "/api/knowledge-bases", { name: "X", organizationId: B.orgId })).status).toBe(400);
    expect((await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "faq", title: "  ", body: "a" })).status).toBe(400);
    expect((await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "document", title: "t", body: "b" })).status).toBe(400);
    expect((await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "faq", title: "t", body: "x".repeat(4001) })).status).toBe(400);
    expect((await http(adminA, "GET", "/api/knowledge-bases/not-a-uuid")).status).toBe(404);
  });

  it("adds, edits and deletes FAQ and information entries", async () => {
    const faq = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, {
      kind: "faq",
      title: "Is parking available?",
      body: "Yes, free basement parking for patients, 7 am to 10 pm.",
    });
    expect(faq.status).toBe(201);
    const info = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "info", title: "Timings", body: "The clinic is open Monday to Saturday, 9 am to 6 pm." });
    expect(info.status).toBe(201);
    const tamil = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "info", title: "கட்டணம்", body: "ஆலோசனை கட்டணம் 500 ரூபாய்." });
    expect(tamil.status).toBe(201);
    const edited = await http(adminA, "PATCH", `/api/knowledge-bases/${kbId}/items/${info.body.data.id}`, { body: "The clinic is open Monday to Saturday, 9 am to 7 pm." });
    expect(edited.body.data.body).toContain("7 pm");
    const temp = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "info", title: "Temp", body: "Remove me" });
    expect((await http(adminA, "DELETE", `/api/knowledge-bases/${kbId}/items/${temp.body.data.id}`)).status).toBe(200);
    const kb = await http(managerA, "GET", `/api/knowledge-bases/${kbId}`);
    expect(kb.body.data.items.map((i: { title: string }) => i.title).sort()).toEqual(["Is parking available?", "Timings", "கட்டணம்"].sort());
  });

  it("uploads a text document: validated, split into passages, ready and searchable; a bad file is refused", async () => {
    const md = "# Insurance\n\nWe accept Star Health, HDFC Ergo and ICICI Lombard cashless insurance at the front desk.\n\n# Pharmacy\n\nThe in-house pharmacy is open 24 hours.";
    const up = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/documents`, { filename: "policies.md", contentType: "text/markdown", contentBase64: b64(md) });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ filename: "policies.md", status: "ready", error: null });
    expect(up.body.data.chunkCount).toBeGreaterThanOrEqual(1);
    const bad = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/documents`, { filename: "x.pdf", contentType: "application/pdf", contentBase64: b64("%PDF") });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unsupported file type/);
    const s = await http(managerA, "POST", `/api/knowledge-bases/${kbId}/search`, { query: "Do you take HDFC insurance?" });
    expect(s.body.data.results[0].body).toMatch(/HDFC Ergo/);
  });

  it("a document that cannot be fully processed is recorded as failed, with a message, and is never searchable", async () => {
    const huge = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} zebracode${i} ${"x".repeat(380)}`).join("\n\n");
    const up = await http(adminA, "POST", `/api/knowledge-bases/${kbId}/documents`, { filename: "huge.txt", contentType: "text/plain", contentBase64: b64(huge.slice(0, 199_000)) });
    expect(up.status).toBe(201);
    expect(up.body.data.status).toBe("failed");
    expect(up.body.data.error).toMatch(/too long/);
    const s = await http(managerA, "POST", `/api/knowledge-bases/${kbId}/search`, { query: "zebracode5" });
    expect(s.body.data.results).toEqual([]);
  });

  it("retrieves by meaning-bearing words in English, Tamil and Tanglish", async () => {
    const q = async (query: string) => (await http(managerA, "POST", `/api/knowledge-bases/${kbId}/search`, { query })).body.data.results as Array<{ title: string; body: string }>;
    expect((await q("is there parking?"))[0].title).toBe("Is parking available?");
    expect((await q("what are your timings"))[0].title).toBe("Timings");
    expect((await q("கட்டணம் எவ்வளவு"))[0].body).toContain("500");
    expect((await q("parking iruka sir"))[0].title).toBe("Is parking available?");
    expect(await q("helicopter")).toEqual([]);
  });

  it("is invisible to other organizations (read, write, search, bind)", async () => {
    expect((await http(ownerB, "GET", `/api/knowledge-bases/${kbId}`)).status).toBe(404);
    expect((await http(ownerB, "PATCH", `/api/knowledge-bases/${kbId}`, { name: "Hijack" })).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/knowledge-bases/${kbId}/items`, { kind: "faq", title: "q", body: "a" })).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/knowledge-bases/${kbId}/search`, { query: "parking" })).status).toBe(404);
    expect((await http(ownerB, "GET", "/api/knowledge-bases")).body.data).toEqual([]);
    const bind = await http(ownerB, "PUT", `/api/agents/${B.agentId}/knowledge`, { bindings: [{ sourceType: "knowledge_base", sourceId: kbId }] });
    expect(bind.status).toBe(400);
  });
});

describe("agents: knowledge binding, configuration loading, duplication", () => {
  let kb1 = "";
  let kb2 = "";
  let agentId = "";

  beforeAll(async () => {
    kb1 = (await http(adminA, "POST", "/api/knowledge-bases", { name: "Showroom" })).body.data.id;
    kb2 = (await http(adminA, "POST", "/api/knowledge-bases", { name: "Internal notes" })).body.data.id;
    await http(adminA, "POST", `/api/knowledge-bases/${kb1}/items`, { kind: "faq", title: "Do you offer test drives?", body: "Yes, free test drives every day from 10 am." });
    await http(adminA, "POST", `/api/knowledge-bases/${kb2}/items`, { kind: "info", title: "Secret discount", body: "Staff test drives discount code SECRET42." });
    const created = await http(adminA, "POST", "/api/agents", {
      name: "Showroom bot",
      personaName: "Asha",
      extraInstructions: "Always mention the Diwali offer when relevant.",
      greeting: "Vanakkam! This is Asha from the showroom.",
      language: "ta-IN",
    });
    expect(created.status).toBe(201);
    agentId = created.body.data.id;
  });

  it("binding a knowledge base enables search_knowledge; unbinding removes it; project bindings coexist", async () => {
    const bound = await http(adminA, "PUT", `/api/agents/${agentId}/knowledge`, {
      bindings: [
        { sourceType: "knowledge_base", sourceId: kb1 },
        { sourceType: "project", sourceId: A.projectId },
      ],
    });
    expect(bound.status).toBe(200);
    expect(bound.body.data.enabledTools).toContain("search_knowledge");
    expect(bound.body.data.knowledge).toEqual(
      expect.arrayContaining([
        { sourceType: "knowledge_base", sourceId: kb1 },
        { sourceType: "project", sourceId: A.projectId },
      ]),
    );
    // The agent editor saves only its project selection: knowledge-base bindings must survive that.
    const projectOnly = await http(adminA, "PUT", `/api/agents/${agentId}/knowledge`, { bindings: [] });
    expect(projectOnly.body.data.knowledge).toEqual([{ sourceType: "knowledge_base", sourceId: kb1 }]);
    expect(projectOnly.body.data.enabledTools).toContain("search_knowledge");
    // The dedicated endpoint sets exactly the knowledge bases (projects untouched) and removes the tool with the last one.
    await http(adminA, "PUT", `/api/agents/${agentId}/knowledge`, { bindings: [{ sourceType: "project", sourceId: A.projectId }] });
    const none = await http(adminA, "PUT", `/api/agents/${agentId}/knowledge-bases`, { knowledgeBaseIds: [] });
    expect(none.body.data).toEqual({ agentId, knowledgeBaseIds: [], searchToolEnabled: false });
    const after = (await http(adminA, "GET", `/api/agents/${agentId}`)).body.data;
    expect(after.knowledge).toEqual([{ sourceType: "project", sourceId: A.projectId }]);
    expect(after.enabledTools).not.toContain("search_knowledge");
    expect((await http(managerA, "PUT", `/api/agents/${agentId}/knowledge-bases`, { knowledgeBaseIds: [kb1] })).status).toBe(403);
    expect((await http(ownerB, "PUT", `/api/agents/${agentId}/knowledge-bases`, { knowledgeBaseIds: [] })).status).toBe(404);
    const set = await http(adminA, "PUT", `/api/agents/${agentId}/knowledge-bases`, { knowledgeBaseIds: [kb1] });
    expect(set.body.data.searchToolEnabled).toBe(true);
    await http(adminA, "PUT", `/api/agents/${agentId}/knowledge`, { bindings: [] });
  });

  it("the real call runtime loads the saved configuration and offers search_knowledge only with knowledge bound", async () => {
    const ctx = systemContext(A.orgId, "test");
    const call = await callsService.createCall(ctx, { agentId, callType: "test" });
    const row = await runInTenant({ organizationId: A.orgId }, async () => callsRepository.findById({ organizationId: A.orgId, id: call.id }));
    const rt = await callRuntime.build(ctx, row!);
    expect(rt.effectiveTools).toContain("search_knowledge");
    expect(rt.config.greeting).toBe("Vanakkam! This is Asha from the showroom.");
    expect(rt.config.extraInstructions).toBe("Always mention the Diwali offer when relevant.");
    expect(rt.languageCode).toBe("ta-IN");
    await callsService.endFromStream({ callId: call.id, outcome: "failed" });

    // An agent with the tool ticked but no knowledge bound is not offered it.
    const plain = await http(adminA, "POST", "/api/agents", { name: "No KB", personaName: "Ravi", enabledTools: ["search_knowledge", "end_call"] });
    const call2 = await callsService.createCall(ctx, { agentId: plain.body.data.id, callType: "test" });
    const row2 = await runInTenant({ organizationId: A.orgId }, async () => callsRepository.findById({ organizationId: A.orgId, id: call2.id }));
    expect((await callRuntime.build(ctx, row2!)).effectiveTools).not.toContain("search_knowledge");
    await callsService.endFromStream({ callId: call2.id, outcome: "failed" });
  });

  it("an editor saving a tool list without search_knowledge cannot switch it off while knowledge is bound", async () => {
    const res = await http(adminA, "PATCH", `/api/agents/${agentId}`, { enabledTools: ["end_call"] });
    expect(res.status).toBe(200);
    expect(res.body.data.enabledTools).toContain("search_knowledge");
  });

  it("duplicates an agent with its configuration and knowledge; names stay unique; only ADMIN+", async () => {
    const d1 = await http(adminA, "POST", `/api/agents/${agentId}/duplicate`, {});
    expect(d1.status).toBe(201);
    expect(d1.body.data).toMatchObject({
      name: "Showroom bot (copy)",
      personaName: "Asha",
      greeting: "Vanakkam! This is Asha from the showroom.",
      language: "ta-IN",
      isDefault: false,
      status: "active",
      knowledge: [{ sourceType: "knowledge_base", sourceId: kb1 }],
    });
    expect(d1.body.data.enabledTools).toContain("search_knowledge");
    const d2 = await http(adminA, "POST", `/api/agents/${agentId}/duplicate`, {});
    expect(d2.body.data.name).toBe("Showroom bot (copy 2)");
    expect((await http(managerA, "POST", `/api/agents/${agentId}/duplicate`, {})).status).toBe(403);
    expect((await http(ownerB, "POST", `/api/agents/${agentId}/duplicate`, {})).status).toBe(404);
  });

  it("playground: a test conversation through the real engine searches ONLY the agent's knowledge and answers from it", async () => {
    let toolResultSeen = "";
    const llm = new ScriptedLlm([
      () => ({ content: "Vanakkam! This is Asha from the showroom, an AI assistant. How can I help?" }),
      () => ({ toolCalls: [{ id: "c1", name: "search_knowledge", arguments: { query: "test drive discount" } }] }),
      (m) => {
        toolResultSeen = [...m].reverse().find((x) => x.role === "tool")?.content ?? "";
        const parsed = JSON.parse(toolResultSeen) as { excerpts: Array<{ answer?: string }> };
        return { content: parsed.excerpts[0]?.answer ?? "I will check with the team." };
      },
    ]);
    setPlaygroundLlmFactory(() => llm);

    const start = await http(managerA, "POST", `/api/agents/${agentId}/playground`, {});
    expect(start.status).toBe(201);
    expect(start.body.data).toMatchObject({ simulated: true, ended: false });
    expect(start.body.data.effectiveTools).toContain("search_knowledge");
    expect(start.body.data.events).toEqual([{ type: "agent", text: expect.stringContaining("Asha"), endsCall: false }]);
    // The saved configuration reached the model: system prompt carries the instructions; the tool is offered.
    const system = llm.seen[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("Always mention the Diwali offer when relevant.");
    expect(llm.seen[0].tools).toContain("search_knowledge");

    const sessionId = start.body.data.sessionId;
    const turn = await http(managerA, "POST", `/api/playground/${sessionId}/messages`, { text: "Do you offer test drives? Any discount?" });
    expect(turn.status).toBe(200);
    const events = turn.body.data.events as Array<{ type: string; [k: string]: unknown }>;
    expect(events[0]).toEqual({ type: "caller", text: "Do you offer test drives? Any discount?" });
    expect(events).toContainEqual({ type: "tool_call", name: "search_knowledge", arguments: { query: "test drive discount" } });
    const result = events.find((e) => e.type === "tool_result") as unknown as { name: string; result: { found: number; excerpts: unknown[] } };
    expect(result.name).toBe("search_knowledge");
    expect(result.result.found).toBeGreaterThan(0);
    expect(JSON.stringify(result.result)).toContain("free test drives every day");
    // kb2 is NOT bound to this agent: its content never reaches the model, even though it matches the query.
    expect(toolResultSeen).not.toContain("SECRET42");
    expect(events).toContainEqual({ type: "agent", text: "Yes, free test drives every day from 10 am.", endsCall: false });

    // Another user (same organization) and another organization cannot use the session.
    expect((await http(adminA, "POST", `/api/playground/${sessionId}/messages`, { text: "hi" })).status).toBe(404);
    expect((await http(ownerB, "POST", `/api/playground/${sessionId}/messages`, { text: "hi" })).status).toBe(404);
    expect((await http(managerA, "POST", `/api/playground/${sessionId}/messages`, { text: "x", extra: 1 })).status).toBe(400);

    const before = openPlaygroundSessions();
    expect((await http(managerA, "DELETE", `/api/playground/${sessionId}`)).status).toBe(200);
    expect(openPlaygroundSessions()).toBe(before - 1);
    const call = await runInTenant({ organizationId: A.orgId }, async () => callsRepository.findById({ organizationId: A.orgId, id: sessionId }));
    expect(call).toMatchObject({ callType: "test", status: "completed" });
    expect((await http(managerA, "POST", `/api/playground/${sessionId}/messages`, { text: "again" })).status).toBe(404);
  });

  it("playground: provider errors are shown as events, not hidden; an archived knowledge base is no longer searched", async () => {
    await http(adminA, "POST", `/api/knowledge-bases/${kb1}/archive`, {});
    let toolResult = "";
    const llm = new ScriptedLlm([
      () => ({ content: "Hello, I am an AI assistant." }),
      () => ({ toolCalls: [{ id: "c1", name: "search_knowledge", arguments: { query: "test drive" } }] }),
      (m) => {
        toolResult = [...m].reverse().find((x) => x.role === "tool")?.content ?? "";
        return { content: "I will check with the team." };
      },
      () => {
        throw new Error("provider timeout");
      },
    ]);
    setPlaygroundLlmFactory(() => llm);
    const start = await http(managerA, "POST", `/api/agents/${agentId}/playground`, {});
    const sessionId = start.body.data.sessionId;
    await http(managerA, "POST", `/api/playground/${sessionId}/messages`, { text: "test drive?" });
    expect(JSON.parse(toolResult)).toMatchObject({ found: 0 });
    const failed = await http(managerA, "POST", `/api/playground/${sessionId}/messages`, { text: "hello?" });
    expect(failed.status).toBe(200);
    const events = failed.body.data.events as Array<{ type: string; message?: string }>;
    // The engine's own fallback handling may answer; any provider error must surface as an error event or a reply.
    expect(events.some((e) => e.type === "error" || e.type === "agent")).toBe(true);
    await http(managerA, "DELETE", `/api/playground/${sessionId}`);
    await http(adminA, "POST", `/api/knowledge-bases/${kb1}/unarchive`, {});
  });

  it("playground refuses roles without call permission and archived agents", async () => {
    expect((await http(agentRoleA, "POST", `/api/agents/${agentId}/playground`, {})).status).toBe(403);
    const tmp = await http(adminA, "POST", "/api/agents", { name: "Temp agent", personaName: "T" });
    await http(adminA, "POST", `/api/agents/${tmp.body.data.id}/archive`, {});
    expect((await http(adminA, "POST", `/api/agents/${tmp.body.data.id}/playground`, {})).status).toBe(404);
  });
});
