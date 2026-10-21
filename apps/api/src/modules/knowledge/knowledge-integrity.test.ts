/**
 * Knowledge base hardening: unauthorized access, invalid / oversized / malformed uploads over HTTP, interrupted
 * processing and retry, duplicate uploads, binding preservation across every agent write path, retrieval isolation
 * (other organizations, unbound and archived knowledge), and a playground turn through the CONFIGURED provider path
 * (no injected model: the mock provider the deployment is configured with in development and CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.MOCK_TELEPHONY_AUTOPLAY = "false";

import { adminDb as db, adminSql } from "../../db/client.js";
import { auditLogs, knowledgeBases, knowledgeDocuments, knowledgeItems } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";
import { httpClient, relaxRateLimits, startTestApp } from "../../test/agent-first.js";
import { knowledgeService } from "./knowledge.service.js";

relaxRateLimits();

let app: Awaited<ReturnType<typeof startTestApp>>["app"];
let baseUrl = "";
let http: ReturnType<typeof httpClient>;
let A: TestTenant;
let B: TestTenant;
let adminA = "";
let managerA = "";
let ownerB = "";
let kbA = "";
let kbA2 = "";
let kbB = "";
let agentA = "";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const upload = (cookie: string, kb: string, filename: string, contentType: string, content: string | Buffer) =>
  http(cookie, "POST", `/api/knowledge-bases/${kb}/documents`, { filename, contentType, contentBase64: b64(content) });

beforeAll(async () => {
  A = await createTenant("KBI_A");
  B = await createTenant("KBI_B");
  const admin = await createMember(A.orgId, "ADMIN");
  const manager = await createMember(A.orgId, "MANAGER");
  const started = await startTestApp();
  app = started.app;
  baseUrl = started.baseUrl;
  http = httpClient(baseUrl);
  adminA = await loginCookie(baseUrl, admin.email);
  managerA = await loginCookie(baseUrl, manager.email);
  ownerB = await loginCookie(baseUrl, B.email);
  kbA = (await http(adminA, "POST", "/api/knowledge-bases", { name: "Store" })).body.data.id;
  kbA2 = (await http(adminA, "POST", "/api/knowledge-bases", { name: "Unbound notes" })).body.data.id;
  kbB = (await http(ownerB, "POST", "/api/knowledge-bases", { name: "Other org" })).body.data.id;
  await http(adminA, "POST", `/api/knowledge-bases/${kbA}/items`, { kind: "faq", title: "Do you deliver?", body: "Yes, free home delivery within 5 km." });
  await http(adminA, "POST", `/api/knowledge-bases/${kbA2}/items`, { kind: "faq", title: "Do you deliver internationally?", body: "UNBOUND-ANSWER" });
  await http(ownerB, "POST", `/api/knowledge-bases/${kbB}/items`, { kind: "faq", title: "Do you deliver?", body: "OTHER-ORG-ANSWER" });
  agentA = (await http(adminA, "POST", "/api/agents", { name: "Store bot", personaName: "Meena" })).body.data.id;
  expect((await http(adminA, "PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: [kbA] })).status).toBe(200);
});

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

describe("unauthorized access", () => {
  it("every knowledge and playground route refuses a request without a session", async () => {
    const anon = (method: string, path: string, body?: unknown) =>
      fetch(`${baseUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
    expect(await anon("GET", "/api/knowledge-bases")).toBe(401);
    expect(await anon("GET", `/api/knowledge-bases/${kbA}`)).toBe(401);
    expect(await anon("POST", `/api/knowledge-bases/${kbA}/search`, { query: "deliver" })).toBe(401);
    expect(await anon("POST", `/api/knowledge-bases/${kbA}/documents`, { filename: "a.txt", contentBase64: "YQ==" })).toBe(401);
    expect(await anon("PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: [] })).toBe(401);
    expect(await anon("POST", `/api/agents/${agentA}/playground`, {})).toBe(401);
  });

  it("a forged or expired session cookie is refused too", async () => {
    expect((await http("va_session=forged", "GET", "/api/knowledge-bases")).status).toBe(401);
  });

  it("MANAGER can read and search but not upload, edit, archive or bind", async () => {
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbA}/search`, { query: "deliver" })).status).toBe(200);
    expect((await upload(managerA, kbA, "a.txt", "text/plain", "hello")).status).toBe(403);
    expect((await http(managerA, "PATCH", `/api/knowledge-bases/${kbA}`, { name: "x" })).status).toBe(403);
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbA}/archive`, {})).status).toBe(403);
    expect((await http(managerA, "PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: [] })).status).toBe(403);
  });
});

describe("upload validation over HTTP", () => {
  it("refuses wrong types, spoofed types, binary, malformed UTF-8, empty and path-like names, with a clear message", async () => {
    const cases: Array<[string, string, string | Buffer, RegExp]> = [
      ["brochure.pdf", "application/pdf", "%PDF-1.7", /Unsupported file type/],
      ["notes.txt", "application/pdf", "hello", /does not match/],
      ["image.txt", "text/plain", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), /not a text file/],
      ["latin1.txt", "text/plain", Buffer.from([0x63, 0x61, 0x66, 0xe9]), /not UTF-8/],
      ["truncated.txt", "text/plain", Buffer.from([0xe0, 0xae]), /not UTF-8/],
      ["blank.txt", "text/plain", "   \n\t  ", /no readable text/],
      ["../secret.txt", "text/plain", "x", /Invalid file name/],
    ];
    for (const [name, type, content, message] of cases) {
      const res = await upload(adminA, kbA, name, type, content);
      expect(res.status, name).toBe(400);
      expect(res.body.error, name).toMatch(message);
    }
    expect((await http(adminA, "POST", `/api/knowledge-bases/${kbA}/documents`, { filename: "a.txt", contentType: "text/plain", contentBase64: "%%%not-base64" })).status).toBe(400);
    expect((await http(adminA, "POST", `/api/knowledge-bases/${kbA}/documents`, { filename: "a.txt", contentBase64: b64("x"), extra: 1 })).status).toBe(400);
    // nothing was recorded for any refused upload
    expect((await http(adminA, "GET", `/api/knowledge-bases/${kbA}`)).body.data.documents).toEqual([]);
  });

  it("refuses an oversized file (over 200 KB) and a body over the route limit", async () => {
    const big = await upload(adminA, kbA, "big.txt", "text/plain", "a".repeat(205 * 1024));
    expect(big.status).toBe(400);
    // Over the route's body limit Fastify refuses to read the body: a 413, or (as here on Node) the connection is closed
    // before the client finishes sending. Either way the upload is refused before any handler runs.
    const huge = await upload(adminA, kbA, "huge.txt", "text/plain", "a".repeat(600 * 1024)).then(
      (r) => r.status,
      (e: { cause?: { code?: string } }) => e.cause?.code ?? "fetch-failed",
    );
    expect([413, "ECONNRESET", "EPIPE", "fetch-failed"]).toContain(huge);
    expect((await http(adminA, "GET", `/api/knowledge-bases/${kbA}`)).body.data.documents).toEqual([]);
  });
});

describe("document processing failures and retry", () => {
  it("a processing failure is recorded as failed (not stuck) and the same file can be uploaded again once fixed", async () => {
    const tooMany = Array.from({ length: 450 }, (_, i) => `Para ${i} ${"y".repeat(380)}`).join("\n\n");
    const failed = await upload(adminA, kbA, "catalogue.txt", "text/plain", tooMany);
    expect(failed.body.data).toMatchObject({ status: "failed", chunkCount: 0 });
    expect(failed.body.data.error).toMatch(/too long/);
    // the corrected file is accepted (re-upload is the retry path; the original bytes are never stored)
    const ok = await upload(adminA, kbA, "catalogue.txt", "text/plain", "Catalogue\n\nWe stock rice, dal and spices.");
    expect(ok.body.data.status).toBe("ready");
  });

  it("a document left in processing by a crash is marked failed after the timeout instead of staying stuck", async () => {
    const [stuck] = await db
      .insert(knowledgeDocuments)
      .values({ organizationId: A.orgId, knowledgeBaseId: kbA, filename: "stuck.txt", contentType: "text/plain", sizeBytes: 10, sha256: "f".repeat(64), status: "processing", updatedAt: new Date(Date.now() - 10 * 60_000) })
      .returning();
    const [fresh] = await db
      .insert(knowledgeDocuments)
      .values({ organizationId: A.orgId, knowledgeBaseId: kbA, filename: "inflight.txt", contentType: "text/plain", sizeBytes: 10, sha256: "e".repeat(64), status: "processing" })
      .returning();
    const docs = (await http(managerA, "GET", `/api/knowledge-bases/${kbA}`)).body.data.documents as Array<{ id: string; status: string; error: string | null }>;
    expect(docs.find((d) => d.id === stuck.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    expect(docs.find((d) => d.id === fresh.id)?.status).toBe("processing"); // still within the window: left alone
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, fresh.id));
  });

  it("uploading a file that is already ready is refused (no duplicated passages); failed ones can be deleted", async () => {
    const content = "Returns\n\nItems can be returned within 7 days with the bill.";
    expect((await upload(adminA, kbA, "returns.txt", "text/plain", content)).body.data.status).toBe("ready");
    const again = await upload(adminA, kbA, "returns-copy.txt", "text/plain", content);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already uploaded as "returns.txt"/);
    const failedDoc = ((await http(adminA, "GET", `/api/knowledge-bases/${kbA}`)).body.data.documents as Array<{ id: string; status: string }>).find((d) => d.status === "failed")!;
    expect((await http(adminA, "DELETE", `/api/knowledge-bases/${kbA}/documents/${failedDoc.id}`)).status).toBe(200);
  });
});

describe("agent writes preserve knowledge bindings and the search tool", () => {
  const state = async () => {
    const a = (await http(adminA, "GET", `/api/agents/${agentA}`)).body.data;
    return { kbs: (a.knowledge as Array<{ sourceType: string; sourceId: string }>).filter((k) => k.sourceType === "knowledge_base").map((k) => k.sourceId), tool: (a.enabledTools as string[]).includes("search_knowledge") };
  };

  it("editing fields, saving a tool list without the tool, saving project bindings, archiving and unarchiving all keep them", async () => {
    expect(await state()).toEqual({ kbs: [kbA], tool: true });
    expect((await http(adminA, "PATCH", `/api/agents/${agentA}`, { greeting: "Vanakkam!", extraInstructions: "Be brief." })).status).toBe(200);
    expect(await state()).toEqual({ kbs: [kbA], tool: true });
    await http(adminA, "PATCH", `/api/agents/${agentA}`, { enabledTools: ["end_call"] });
    expect(await state()).toEqual({ kbs: [kbA], tool: true });
    await http(adminA, "PUT", `/api/agents/${agentA}/knowledge`, { bindings: [{ sourceType: "project", sourceId: A.projectId }] });
    expect(await state()).toEqual({ kbs: [kbA], tool: true });
    await http(adminA, "POST", `/api/agents/${agentA}/archive`, {});
    await http(adminA, "POST", `/api/agents/${agentA}/unarchive`, {});
    expect(await state()).toEqual({ kbs: [kbA], tool: true });
  });

  it("archiving a knowledge base keeps the binding but excludes it from retrieval; unarchiving restores it", async () => {
    const ctx = systemContext(A.orgId, "test");
    expect((await knowledgeService.searchForAgent(ctx, { agentId: agentA, query: "deliver" })).length).toBeGreaterThan(0);
    await http(adminA, "POST", `/api/knowledge-bases/${kbA}/archive`, {});
    expect(await knowledgeService.searchForAgent(ctx, { agentId: agentA, query: "deliver" })).toEqual([]);
    expect((await state()).kbs).toEqual([kbA]);
    // an archived knowledge base cannot be newly bound
    expect((await http(adminA, "PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: [kbA] })).status).toBe(400);
    await http(adminA, "POST", `/api/knowledge-bases/${kbA}/unarchive`, {});
    expect((await knowledgeService.searchForAgent(ctx, { agentId: agentA, query: "deliver" })).length).toBeGreaterThan(0);
  });
});

describe("retrieval isolation", () => {
  it("returns only the agent's bound knowledge: never an unbound knowledge base, never another organization", async () => {
    const hits = await knowledgeService.searchForAgent(systemContext(A.orgId, "test"), { agentId: agentA, query: "do you deliver internationally" });
    const bodies = hits.map((h) => h.body);
    expect(bodies).toContain("Yes, free home delivery within 5 km.");
    expect(bodies).not.toContain("UNBOUND-ANSWER");
    expect(bodies).not.toContain("OTHER-ORG-ANSWER");
  });

  it("another organization's context gets nothing for this agent, and this organization gets nothing for B's agent", async () => {
    expect(await knowledgeService.searchForAgent(systemContext(B.orgId, "test"), { agentId: agentA, query: "deliver" })).toEqual([]);
    const agentB = (await http(ownerB, "POST", "/api/agents", { name: "B bot", personaName: "X" })).body.data.id;
    await http(ownerB, "PUT", `/api/agents/${agentB}/knowledge-bases`, { knowledgeBaseIds: [kbB] });
    expect(await knowledgeService.searchForAgent(systemContext(A.orgId, "test"), { agentId: agentB, query: "deliver" })).toEqual([]);
    expect((await knowledgeService.searchForAgent(systemContext(B.orgId, "test"), { agentId: agentB, query: "deliver" })).map((h) => h.body)).toEqual(["OTHER-ORG-ANSWER"]);
  });

  it("refuses bindings to another organization's or a nonexistent knowledge base, on both binding endpoints", async () => {
    expect((await http(adminA, "PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: [kbB] })).status).toBe(400);
    expect((await http(adminA, "PUT", `/api/agents/${agentA}/knowledge`, { bindings: [{ sourceType: "knowledge_base", sourceId: kbB }] })).status).toBe(400);
    expect((await http(adminA, "PUT", `/api/agents/${agentA}/knowledge-bases`, { knowledgeBaseIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });

  it("validates search queries: empty, too long and unknown fields are refused", async () => {
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbA}/search`, { query: "" })).status).toBe(400);
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbA}/search`, { query: "x".repeat(501) })).status).toBe(400);
    expect((await http(managerA, "POST", `/api/knowledge-bases/${kbA}/search`, { query: "deliver", limit: 1000 })).status).toBe(400);
    const punct = await http(managerA, "POST", `/api/knowledge-bases/${kbA}/search`, { query: "!!! ??? & | ( ) :* '" });
    expect(punct.status).toBe(200); // tsquery syntax characters are never passed through
    expect(punct.body.data.results).toEqual([]);
  });
});

describe("playground through the configured provider (development mock)", () => {
  it("the agent looks the question up in its knowledge and answers from it", async () => {
    const start = await http(managerA, "POST", `/api/agents/${agentA}/playground`, {});
    expect(start.status).toBe(201);
    const turn = await http(managerA, "POST", `/api/playground/${start.body.data.sessionId}/messages`, { text: "Do you deliver?" });
    const events = turn.body.data.events as Array<{ type: string; name?: string; text?: string }>;
    expect(events.map((e) => e.type)).toEqual(["caller", "tool_call", "tool_result", "agent"]);
    expect(events[1].name).toBe("search_knowledge");
    expect(events[3].text).toBe("Yes, free home delivery within 5 km.");
    await http(managerA, "DELETE", `/api/playground/${start.body.data.sessionId}`);
  });
});
