/**
 * The knowledge base: organization-owned collections of FAQs, business information and uploaded text documents that
 * agents are bound to (agent_knowledge_bindings, source type "knowledge_base") and search during a conversation.
 *
 * Authorization (service layer): reading needs agents:read (MANAGER and up); changing needs agents:manage (ADMIN and
 * up). Every query is addressed by the context's organization and runs under row-level security; a knowledge base
 * id from another organization is simply "not found".
 */
import { z } from "zod";
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { knowledgeRepository, type KnowledgeHit } from "../../db/repositories/knowledge.repository.js";
import { isUniqueViolation } from "../../db/pg-error.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { parseInput } from "../../shared/validation.js";
import { auditService } from "../audit/audit.service.js";
import { KNOWLEDGE_BASE_SOURCE, SEARCH_KNOWLEDGE_TOOL } from "../agents/agents.constants.js";
import {
  chunkText,
  cleanText,
  csvToPassages,
  decodeUpload,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_ITEM_BODY_CHARS,
  MAX_ITEM_TITLE_CHARS,
  queryTerms,
  UploadRejectedError,
} from "./knowledge-text.js";

export const KNOWLEDGE_SOURCE_TYPE = KNOWLEDGE_BASE_SOURCE;
export const MAX_KNOWLEDGE_BASES_PER_ORG = 50;
export const MAX_ITEMS_PER_KNOWLEDGE_BASE = 2000;
export const SEARCH_RESULT_LIMIT = 5;
/** A document still "processing" after this long was interrupted (processing itself takes well under a second). */
export const STALE_PROCESSING_MS = 5 * 60_000;

const cleaned = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => cleanText(v))
    .pipe(z.string().min(1).max(max));

const baseCreate = z
  .object({ name: cleaned(120), description: z.string().max(2000).transform((v) => cleanText(v)).nullable().optional() })
  .strict();
const baseUpdate = baseCreate.partial().strict();
const itemCreate = z
  .object({ kind: z.enum(["faq", "info"]), title: cleaned(MAX_ITEM_TITLE_CHARS), body: cleaned(MAX_ITEM_BODY_CHARS) })
  .strict();
const itemUpdate = z.object({ title: cleaned(MAX_ITEM_TITLE_CHARS), body: cleaned(MAX_ITEM_BODY_CHARS) }).partial().strict();
const uploadBody = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(100).default(""),
    // base64 of at most 200 KB (4/3 overhead plus slack); the decoded size is checked again in decodeUpload
    contentBase64: z.string().min(1).max(280_000),
  })
  .strict();
const agentBasesBody = z.object({ knowledgeBaseIds: z.array(z.string().uuid()).max(20) }).strict();
const searchBody = z.object({ query: z.string().trim().min(1).max(500) }).strict();
const uuid = z.string().uuid();

const userIdOf = (ctx: RequestContext) => (ctx.actor.type === "user" ? ctx.actor.userId : null);

function itemView(i: { id: string; kind: string; title: string; body: string; documentId: string | null; position: number; updatedAt: Date }) {
  return { id: i.id, kind: i.kind, title: i.title, body: i.body, documentId: i.documentId, position: i.position, updatedAt: i.updatedAt.toISOString() };
}

function documentView(d: {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  error: string | null;
  chunkCount: number;
  createdAt: Date;
}) {
  return {
    id: d.id,
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    status: d.status,
    error: d.error,
    chunkCount: d.chunkCount,
    createdAt: d.createdAt.toISOString(),
  };
}

async function loadBase(ctx: RequestContext, id: string, opts: { active?: boolean } = {}) {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Knowledge base not found");
  const base = await knowledgeRepository.findBase({ organizationId: ctx.organizationId, id });
  if (!base) throw new NotFoundError("Knowledge base not found");
  if (opts.active && base.status !== "active") throw new ConflictError("This knowledge base is archived");
  return base;
}

async function assertRoomForItems(ctx: RequestContext, knowledgeBaseId: string, adding: number) {
  const n = await knowledgeRepository.countItems({ organizationId: ctx.organizationId, knowledgeBaseId });
  if (n + adding > MAX_ITEMS_PER_KNOWLEDGE_BASE) {
    throw new ValidationError(`A knowledge base can hold at most ${MAX_ITEMS_PER_KNOWLEDGE_BASE} entries (this one has ${n}).`);
  }
}

/** The knowledge bases bound to an agent (ids), in binding order. */
export async function knowledgeBaseIdsForAgent(organizationId: string, agentId: string): Promise<string[]> {
  const bindings = await agentsRepository.listBindings({ organizationId, agentIds: [agentId] });
  return bindings.filter((b) => b.sourceType === KNOWLEDGE_SOURCE_TYPE).map((b) => b.sourceId);
}

const knowledgeServiceImpl = {
  async list(ctx: RequestContext, opts: { includeArchived?: boolean } = {}) {
    assertCan(ctx, "agents:read");
    const rows = await knowledgeRepository.listBases({ organizationId: ctx.organizationId, includeArchived: opts.includeArchived });
    return rows.map((r) => ({
      id: r.base.id,
      name: r.base.name,
      description: r.base.description,
      status: r.base.status,
      itemCount: r.items,
      documentCount: r.documents,
      updatedAt: r.base.updatedAt.toISOString(),
    }));
  },

  async get(ctx: RequestContext, id: string) {
    assertCan(ctx, "agents:read");
    const base = await loadBase(ctx, id);
    await knowledgeRepository.failStaleProcessing({
      organizationId: ctx.organizationId,
      knowledgeBaseId: base.id,
      before: new Date(Date.now() - STALE_PROCESSING_MS),
    });
    const [items, documents] = await Promise.all([
      knowledgeRepository.listItems({ organizationId: ctx.organizationId, knowledgeBaseId: base.id }),
      knowledgeRepository.listDocuments({ organizationId: ctx.organizationId, knowledgeBaseId: base.id }),
    ]);
    return {
      id: base.id,
      name: base.name,
      description: base.description,
      status: base.status,
      updatedAt: base.updatedAt.toISOString(),
      // Document passages are listed under their document, not as separate entries.
      items: items.filter((i) => i.kind !== "document").map(itemView),
      documents: documents.map(documentView),
    };
  },

  async create(ctx: RequestContext, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(baseCreate, input);
    if ((await knowledgeRepository.countActiveBases({ organizationId: ctx.organizationId })) >= MAX_KNOWLEDGE_BASES_PER_ORG) {
      throw new ValidationError(`An organization can have at most ${MAX_KNOWLEDGE_BASES_PER_ORG} active knowledge bases`);
    }
    try {
      const base = await knowledgeRepository.createBase({
        organizationId: ctx.organizationId,
        name: data.name,
        description: data.description ?? null,
        createdByUserId: userIdOf(ctx),
      });
      await auditService.record(ctx, { action: "knowledge_base.created", entityType: "knowledge_base", entityId: base.id, metadata: { name: base.name } });
      return knowledgeServiceImpl.get(ctx, base.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("A knowledge base with this name already exists");
      throw err;
    }
  },

  async update(ctx: RequestContext, id: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(baseUpdate, input);
    const base = await loadBase(ctx, id, { active: true });
    try {
      await knowledgeRepository.updateBase({
        organizationId: ctx.organizationId,
        id: base.id,
        values: { ...(data.name !== undefined ? { name: data.name } : {}), ...(data.description !== undefined ? { description: data.description ?? null } : {}) },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("A knowledge base with this name already exists");
      throw err;
    }
    await auditService.record(ctx, { action: "knowledge_base.updated", entityType: "knowledge_base", entityId: base.id, metadata: { name: data.name ?? base.name } });
    return knowledgeServiceImpl.get(ctx, base.id);
  },

  /** Archived knowledge is never searched; agent bindings stay so unarchiving restores them. */
  async setArchived(ctx: RequestContext, id: string, archived: boolean) {
    assertCan(ctx, "agents:manage");
    const base = await loadBase(ctx, id);
    try {
      await knowledgeRepository.updateBase({ organizationId: ctx.organizationId, id: base.id, values: { status: archived ? "archived" : "active" } });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("An active knowledge base with this name already exists. Rename one of them first.");
      throw err;
    }
    await auditService.record(ctx, {
      action: archived ? "knowledge_base.archived" : "knowledge_base.unarchived",
      entityType: "knowledge_base",
      entityId: base.id,
      metadata: { name: base.name },
    });
    return knowledgeServiceImpl.get(ctx, base.id);
  },

  async addItem(ctx: RequestContext, knowledgeBaseId: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(itemCreate, input);
    const base = await loadBase(ctx, knowledgeBaseId, { active: true });
    await assertRoomForItems(ctx, base.id, 1);
    const position = await knowledgeRepository.countItems({ organizationId: ctx.organizationId, knowledgeBaseId: base.id });
    const item = await knowledgeRepository.createItem({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, ...data, position });
    await auditService.record(ctx, { action: "knowledge_item.created", entityType: "knowledge_base", entityId: base.id, metadata: { itemId: item.id, kind: item.kind } });
    return itemView(item);
  },

  async updateItem(ctx: RequestContext, knowledgeBaseId: string, itemId: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(itemUpdate, input);
    const base = await loadBase(ctx, knowledgeBaseId, { active: true });
    if (!uuid.safeParse(itemId).success) throw new NotFoundError("Entry not found");
    const item = await knowledgeRepository.findItem({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: itemId });
    if (!item) throw new NotFoundError("Entry not found");
    if (item.kind === "document") throw new ConflictError("Document passages are changed by uploading the document again");
    const updated = await knowledgeRepository.updateItem({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: item.id, values: data });
    await auditService.record(ctx, { action: "knowledge_item.updated", entityType: "knowledge_base", entityId: base.id, metadata: { itemId: item.id } });
    return itemView(updated!);
  },

  async deleteItem(ctx: RequestContext, knowledgeBaseId: string, itemId: string) {
    assertCan(ctx, "agents:manage");
    const base = await loadBase(ctx, knowledgeBaseId);
    if (!uuid.safeParse(itemId).success) throw new NotFoundError("Entry not found");
    const item = await knowledgeRepository.findItem({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: itemId });
    if (!item) throw new NotFoundError("Entry not found");
    if (item.kind === "document") throw new ConflictError("Delete the document to remove its passages");
    await knowledgeRepository.deleteItem({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: item.id });
    await auditService.record(ctx, { action: "knowledge_item.deleted", entityType: "knowledge_base", entityId: base.id, metadata: { itemId: item.id } });
    return { deleted: true };
  },

  /**
   * Uploads a text document (.txt, .md, .csv). Validated before anything is stored; the document is recorded as
   * "processing", split into passages, and then marked "ready" together with its passages in one transaction. A
   * failure after the record exists marks it "failed" with a message (it is never left searchable half-done).
   */
  async uploadDocument(ctx: RequestContext, knowledgeBaseId: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const data = parseInput(uploadBody, input);
    const base = await loadBase(ctx, knowledgeBaseId, { active: true });
    let decoded;
    try {
      decoded = decodeUpload(data);
    } catch (err) {
      if (err instanceof UploadRejectedError) throw new ValidationError(err.message);
      throw err;
    }
    // Re-uploading after a failure is the retry path (the bytes are never stored); re-uploading a file that is already
    // ready would only duplicate its passages, so it is refused.
    const duplicate = await knowledgeRepository.findReadyBySha({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, sha256: decoded.sha256 });
    if (duplicate) throw new ConflictError(`This file was already uploaded as "${duplicate.filename}"`);
    const doc = await knowledgeRepository.createDocument({
      organizationId: ctx.organizationId,
      knowledgeBaseId: base.id,
      filename: data.filename.trim(),
      contentType: data.contentType.trim().toLowerCase().split(";")[0] || "text/plain",
      sizeBytes: decoded.sizeBytes,
      sha256: decoded.sha256,
      createdByUserId: userIdOf(ctx),
    });
    try {
      const passages = (decoded.extension === ".csv" ? csvToPassages(decoded.text) : chunkText(decoded.text))
        .map((p) => p.slice(0, MAX_ITEM_BODY_CHARS))
        .filter((p) => p.trim().length > 0);
      if (passages.length === 0) throw new UploadRejectedError("No readable text was found in the document");
      if (passages.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw new UploadRejectedError(`The document is too long (${passages.length} passages; at most ${MAX_CHUNKS_PER_DOCUMENT})`);
      }
      await assertRoomForItems(ctx, base.id, passages.length);
      const ready = await knowledgeRepository.completeDocument({
        organizationId: ctx.organizationId,
        knowledgeBaseId: base.id,
        documentId: doc.id,
        passages,
      });
      await auditService.record(ctx, {
        action: "knowledge_document.uploaded",
        entityType: "knowledge_base",
        entityId: base.id,
        metadata: { documentId: doc.id, filename: doc.filename, sizeBytes: doc.sizeBytes, passages: passages.length },
      });
      return documentView(ready);
    } catch (err) {
      const message =
        err instanceof UploadRejectedError || err instanceof ValidationError ? err.message : "The document could not be processed";
      if (!(err instanceof UploadRejectedError || err instanceof ValidationError)) {
        logger.error("knowledge: document processing failed", { documentId: doc.id, error: err instanceof Error ? err.message : String(err) });
      }
      const failed = await knowledgeRepository.failDocument({ organizationId: ctx.organizationId, documentId: doc.id, error: message });
      return documentView(failed ?? doc);
    }
  },

  async deleteDocument(ctx: RequestContext, knowledgeBaseId: string, documentId: string) {
    assertCan(ctx, "agents:manage");
    const base = await loadBase(ctx, knowledgeBaseId);
    if (!uuid.safeParse(documentId).success) throw new NotFoundError("Document not found");
    const doc = await knowledgeRepository.findDocument({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: documentId });
    if (!doc) throw new NotFoundError("Document not found");
    await knowledgeRepository.deleteDocument({ organizationId: ctx.organizationId, knowledgeBaseId: base.id, id: doc.id });
    await auditService.record(ctx, { action: "knowledge_document.deleted", entityType: "knowledge_base", entityId: base.id, metadata: { documentId: doc.id, filename: doc.filename } });
    return { deleted: true };
  },

  /**
   * Sets exactly which knowledge bases an agent uses (other binding types, e.g. Sales projects, are untouched), and
   * enables or removes the agent's search_knowledge tool to match. Only active knowledge bases of this organization.
   */
  async setAgentKnowledgeBases(ctx: RequestContext, agentId: string, input: unknown) {
    assertCan(ctx, "agents:manage");
    const { knowledgeBaseIds } = parseInput(agentBasesBody, input);
    if (!uuid.safeParse(agentId).success) throw new NotFoundError("Agent not found");
    const agent = await agentsRepository.findById({ organizationId: ctx.organizationId, id: agentId });
    if (!agent) throw new NotFoundError("Agent not found");
    if (agent.status === "archived") throw new ConflictError("An archived agent cannot be changed. Unarchive it first.");
    const wanted = [...new Set(knowledgeBaseIds)];
    const active = await knowledgeRepository.activeBaseIds({ organizationId: ctx.organizationId, ids: wanted });
    const missing = wanted.filter((id) => !active.includes(id));
    if (missing.length > 0) throw new ValidationError(`Knowledge base not found or archived: ${missing.join(", ")}`);
    const existing = await agentsRepository.listBindings({ organizationId: ctx.organizationId, agentIds: [agent.id] });
    const others = existing
      .filter((b) => b.sourceType !== KNOWLEDGE_SOURCE_TYPE)
      .map((b) => ({ sourceType: b.sourceType, sourceId: b.sourceId }));
    await agentsRepository.replaceBindings({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      bindings: [...others, ...wanted.map((sourceId) => ({ sourceType: KNOWLEDGE_SOURCE_TYPE, sourceId }))],
    });
    const tools = (Array.isArray(agent.enabledTools) ? agent.enabledTools : []).filter((t): t is string => typeof t === "string");
    const has = tools.includes(SEARCH_KNOWLEDGE_TOOL);
    if (wanted.length > 0 !== has) {
      const next = wanted.length > 0 ? [...tools, SEARCH_KNOWLEDGE_TOOL] : tools.filter((t) => t !== SEARCH_KNOWLEDGE_TOOL);
      await agentsRepository.update({ organizationId: ctx.organizationId, id: agent.id, values: { enabledTools: next, updatedByUserId: userIdOf(ctx) } });
    }
    await auditService.record(ctx, {
      action: "agent.knowledge_bases_updated",
      entityType: "agent",
      entityId: agent.id,
      metadata: { name: agent.name, knowledgeBaseIds: wanted },
    });
    return { agentId: agent.id, knowledgeBaseIds: wanted, searchToolEnabled: wanted.length > 0 };
  },

  /** What an agent bound to this knowledge base would retrieve for `query` (dashboard preview of retrieval). */
  async searchPreview(ctx: RequestContext, knowledgeBaseId: string, input: unknown) {
    assertCan(ctx, "agents:read");
    const { query } = parseInput(searchBody, input);
    const base = await loadBase(ctx, knowledgeBaseId);
    const terms = queryTerms(query);
    const hits = await knowledgeRepository.search({ organizationId: ctx.organizationId, knowledgeBaseIds: [base.id], terms, limit: SEARCH_RESULT_LIMIT });
    return { query, terms, results: hits.map(hitView) };
  },

  /**
   * Retrieval for a live conversation (system context of the call's organization): only knowledge bases bound to
   * THIS agent, only active ones, only ready documents. The agent id comes from the call record, never the model.
   */
  async searchForAgent(ctx: RequestContext, params: { agentId: string; query: string }) {
    const knowledgeBaseIds = await knowledgeBaseIdsForAgent(ctx.organizationId, params.agentId);
    const terms = queryTerms(params.query.slice(0, 500));
    if (knowledgeBaseIds.length === 0 || terms.length === 0) return [];
    return knowledgeRepository.search({ organizationId: ctx.organizationId, knowledgeBaseIds, terms, limit: SEARCH_RESULT_LIMIT });
  },
};

function hitView(h: KnowledgeHit) {
  return { id: h.id, knowledgeBase: h.knowledgeBaseName, kind: h.kind, title: h.title, body: h.body, rank: Number(h.rank) };
}

export const knowledgeService = tenantScoped(knowledgeServiceImpl);
