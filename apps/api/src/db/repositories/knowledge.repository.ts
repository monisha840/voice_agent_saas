import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client.js";
import { knowledgeBases, knowledgeDocuments, knowledgeItems } from "../schema.js";

export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type KnowledgeItemRow = typeof knowledgeItems.$inferSelect;
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

export interface KnowledgeHit {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  kind: string;
  title: string;
  body: string;
  rank: number;
}

/** Every method is addressed by { organizationId } (row-level security also confines it to the active organization). */
export const knowledgeRepository = {
  async listBases(params: { organizationId: string; includeArchived?: boolean }) {
    return db
      .select({
        base: knowledgeBases,
        items: sql<number>`(select count(*)::int from ${knowledgeItems} i where i.organization_id = ${knowledgeBases.organizationId} and i.knowledge_base_id = ${knowledgeBases.id})`,
        documents: sql<number>`(select count(*)::int from ${knowledgeDocuments} d where d.organization_id = ${knowledgeBases.organizationId} and d.knowledge_base_id = ${knowledgeBases.id})`,
      })
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.organizationId, params.organizationId),
          params.includeArchived ? undefined : eq(knowledgeBases.status, "active"),
        ),
      )
      .orderBy(asc(knowledgeBases.name));
  },

  async findBase(params: { organizationId: string; id: string }) {
    const rows = await db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.organizationId, params.organizationId), eq(knowledgeBases.id, params.id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async countActiveBases(params: { organizationId: string }) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.organizationId, params.organizationId), eq(knowledgeBases.status, "active")));
    return r.n;
  },

  async createBase(params: { organizationId: string; name: string; description: string | null; createdByUserId: string | null }) {
    const rows = await db.insert(knowledgeBases).values(params).returning();
    return rows[0];
  },

  async updateBase(params: {
    organizationId: string;
    id: string;
    values: Partial<Pick<typeof knowledgeBases.$inferInsert, "name" | "description" | "status">>;
  }) {
    const rows = await db
      .update(knowledgeBases)
      .set({ ...params.values, updatedAt: new Date() })
      .where(and(eq(knowledgeBases.organizationId, params.organizationId), eq(knowledgeBases.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  async listItems(params: { organizationId: string; knowledgeBaseId: string }) {
    return db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.organizationId, params.organizationId), eq(knowledgeItems.knowledgeBaseId, params.knowledgeBaseId)))
      .orderBy(asc(knowledgeItems.kind), asc(knowledgeItems.position), asc(knowledgeItems.createdAt));
  },

  async countItems(params: { organizationId: string; knowledgeBaseId: string }) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.organizationId, params.organizationId), eq(knowledgeItems.knowledgeBaseId, params.knowledgeBaseId)));
    return r.n;
  },

  async findItem(params: { organizationId: string; knowledgeBaseId: string; id: string }) {
    const rows = await db
      .select()
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.organizationId, params.organizationId),
          eq(knowledgeItems.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeItems.id, params.id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async createItem(params: {
    organizationId: string;
    knowledgeBaseId: string;
    kind: "faq" | "info";
    title: string;
    body: string;
    position: number;
  }) {
    const rows = await db.insert(knowledgeItems).values(params).returning();
    return rows[0];
  },

  async updateItem(params: { organizationId: string; knowledgeBaseId: string; id: string; values: { title?: string; body?: string } }) {
    const rows = await db
      .update(knowledgeItems)
      .set({ ...params.values, updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeItems.organizationId, params.organizationId),
          eq(knowledgeItems.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeItems.id, params.id),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async deleteItem(params: { organizationId: string; knowledgeBaseId: string; id: string }) {
    const rows = await db
      .delete(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.organizationId, params.organizationId),
          eq(knowledgeItems.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeItems.id, params.id),
        ),
      )
      .returning({ id: knowledgeItems.id });
    return rows.length > 0;
  },

  async listDocuments(params: { organizationId: string; knowledgeBaseId: string }) {
    return db
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.organizationId, params.organizationId), eq(knowledgeDocuments.knowledgeBaseId, params.knowledgeBaseId)))
      .orderBy(desc(knowledgeDocuments.createdAt));
  },

  async createDocument(params: {
    organizationId: string;
    knowledgeBaseId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    createdByUserId: string | null;
  }) {
    const rows = await db.insert(knowledgeDocuments).values({ ...params, status: "processing" }).returning();
    return rows[0];
  },

  /** Stores a document's passages and marks it ready, in ONE transaction (no half-processed document is searchable). */
  async completeDocument(params: { organizationId: string; knowledgeBaseId: string; documentId: string; passages: string[] }) {
    return db.transaction(async (tx) => {
      if (params.passages.length > 0) {
        await tx.insert(knowledgeItems).values(
          params.passages.map((body, position) => ({
            organizationId: params.organizationId,
            knowledgeBaseId: params.knowledgeBaseId,
            documentId: params.documentId,
            kind: "document",
            title: "",
            body,
            position,
          })),
        );
      }
      const rows = await tx
        .update(knowledgeDocuments)
        .set({ status: "ready", chunkCount: params.passages.length, error: null, updatedAt: new Date() })
        .where(and(eq(knowledgeDocuments.organizationId, params.organizationId), eq(knowledgeDocuments.id, params.documentId)))
        .returning();
      return rows[0];
    });
  },

  /**
   * Marks documents stuck in "processing" since before `before` as failed (a crash or restart between recording the
   * upload and finishing it). Their passages were never committed, so nothing half-done is searchable.
   */
  async failStaleProcessing(params: { organizationId: string; knowledgeBaseId: string; before: Date }) {
    const rows = await db
      .update(knowledgeDocuments)
      .set({ status: "failed", error: "Processing was interrupted. Upload the file again.", updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeDocuments.organizationId, params.organizationId),
          eq(knowledgeDocuments.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeDocuments.status, "processing"),
          sql`${knowledgeDocuments.updatedAt} < ${params.before.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: knowledgeDocuments.id });
    return rows.length;
  },

  /** A READY document of this knowledge base with the same content hash (duplicate upload), if any. */
  async findReadyBySha(params: { organizationId: string; knowledgeBaseId: string; sha256: string }) {
    const rows = await db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.organizationId, params.organizationId),
          eq(knowledgeDocuments.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeDocuments.sha256, params.sha256),
          eq(knowledgeDocuments.status, "ready"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async failDocument(params: { organizationId: string; documentId: string; error: string }) {
    const rows = await db
      .update(knowledgeDocuments)
      .set({ status: "failed", error: params.error.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(knowledgeDocuments.organizationId, params.organizationId), eq(knowledgeDocuments.id, params.documentId)))
      .returning();
    return rows[0] ?? null;
  },

  async findDocument(params: { organizationId: string; knowledgeBaseId: string; id: string }) {
    const rows = await db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.organizationId, params.organizationId),
          eq(knowledgeDocuments.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeDocuments.id, params.id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Deletes a document and (by cascade) its passages. */
  async deleteDocument(params: { organizationId: string; knowledgeBaseId: string; id: string }) {
    const rows = await db
      .delete(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.organizationId, params.organizationId),
          eq(knowledgeDocuments.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeDocuments.id, params.id),
        ),
      )
      .returning({ id: knowledgeDocuments.id });
    return rows.length > 0;
  },

  /** Active knowledge bases of the organization among `ids` (to validate bindings). */
  async activeBaseIds(params: { organizationId: string; ids: string[] }) {
    if (params.ids.length === 0) return [];
    const rows = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.organizationId, params.organizationId),
          eq(knowledgeBases.status, "active"),
          inArray(knowledgeBases.id, params.ids),
        ),
      );
    return rows.map((r) => r.id);
  },

  /**
   * Ranked passages from ACTIVE knowledge bases among `knowledgeBaseIds` (an agent's bindings), from FAQs, information
   * items and passages of READY documents only. Full-text match first (any of the terms); if that finds nothing, a
   * substring match on the same terms (covers scripts and spellings the text parser splits differently).
   * Ranking uses ts_rank (title weighted above body), not ts_rank_cd: ts_rank_cd's positional scoring cost ~0.08 ms per
   * matching row and dominated latency at volume (measured in knowledge-scale.test.ts).
   */
  async search(params: { organizationId: string; knowledgeBaseIds: string[]; terms: string[]; limit: number }): Promise<KnowledgeHit[]> {
    if (params.knowledgeBaseIds.length === 0 || params.terms.length === 0) return [];
    const kbIds = sql.join(params.knowledgeBaseIds.map((id) => sql`${id}::uuid`), sql`, `);
    const base = sql`
      from knowledge_items i
      join knowledge_bases kb on kb.organization_id = i.organization_id and kb.id = i.knowledge_base_id and kb.status = 'active'
      left join knowledge_documents d on d.organization_id = i.organization_id and d.id = i.document_id
      where i.organization_id = ${params.organizationId}
        and i.knowledge_base_id in (${kbIds})
        and (i.document_id is null or d.status = 'ready')`;
    const tsq = params.terms.join(" | ");
    const fts = (await db.execute(sql`
      select i.id, i.knowledge_base_id as "knowledgeBaseId", kb.name as "knowledgeBaseName", i.kind, i.title, i.body,
             ts_rank(i.search, to_tsquery('simple', ${tsq}))::float8 as rank
      ${base} and i.search @@ to_tsquery('simple', ${tsq})
      order by rank desc, i.position asc
      limit ${params.limit}`)) as unknown as KnowledgeHit[];
    if (fts.length > 0) return fts;
    const patterns = sql.join(params.terms.map((t) => sql`${`%${t}%`}`), sql`, `);
    const like = (await db.execute(sql`
      select i.id, i.knowledge_base_id as "knowledgeBaseId", kb.name as "knowledgeBaseName", i.kind, i.title, i.body,
             (select count(*) from unnest(array[${patterns}]::text[]) p where i.title ilike p or i.body ilike p)::float8 as rank
      ${base} and (i.title ilike any(array[${patterns}]::text[]) or i.body ilike any(array[${patterns}]::text[]))
      order by rank desc, i.position asc
      limit ${params.limit}`)) as unknown as KnowledgeHit[];
    return like;
  },
};
