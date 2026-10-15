import { and, desc, eq, getTableColumns, gte, ilike, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { leads, users, type leadStatusEnum } from "../schema.js";
import type { LeadScope } from "../../auth/scope.js";

type LeadStatus = (typeof leadStatusEnum.enumValues)[number];

/** Turns an access scope into a WHERE fragment (undefined = no extra restriction). */
export function scopeCondition(scope?: LeadScope): SQL | undefined {
  if (!scope || scope.kind === "all") return undefined;
  if (scope.kind === "projects") {
    return scope.projectIds.length > 0 ? inArray(leads.projectId, scope.projectIds) : sql`false`;
  }
  return eq(leads.assignedUserId, scope.userId);
}

export interface LeadListParams {
  organizationId: string;
  scope?: LeadScope;
  status?: LeadStatus;
  projectId?: string;
  assignedTo?: string;
  /** Case-insensitive match on the name, or on the phone number's digits. */
  search?: string;
}

/** LIKE wildcards in user input are matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function listCondition(params: LeadListParams): SQL | undefined {
  const term = params.search?.trim();
  const digits = term?.replace(/\D/g, "") ?? "";
  return and(
    eq(leads.organizationId, params.organizationId),
    scopeCondition(params.scope),
    params.status ? eq(leads.status, params.status) : undefined,
    params.projectId ? eq(leads.projectId, params.projectId) : undefined,
    params.assignedTo ? eq(leads.assignedUserId, params.assignedTo) : undefined,
    term
      ? or(
          ilike(leads.name, `%${likeEscape(term)}%`),
          digits.length >= 3 ? like(leads.phone, `%${digits}%`) : undefined,
        )
      : undefined,
  );
}

/**
 * Every method requires an organizationId and filters by it. Read methods
 * also take an optional `scope` that narrows results to what a MANAGER or
 * AGENT may see (see auth/scope.ts).
 */
export const leadsRepository = {
  /** The lead plus its assignee's display name (never the assignee's email). */
  async findById(params: { organizationId: string; id: string; scope?: LeadScope }) {
    const rows = await db
      .select({ ...getTableColumns(leads), assigneeName: users.name })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.assignedUserId))
      .where(and(eq(leads.organizationId, params.organizationId), eq(leads.id, params.id), scopeCondition(params.scope)))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Filters are ANDed with the organization and scope conditions, so they can only narrow the result. */
  async list(params: LeadListParams & { limit?: number; offset?: number }) {
    const query = db
      .select({ ...getTableColumns(leads), assigneeName: users.name })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.assignedUserId))
      .where(listCondition(params))
      .orderBy(desc(leads.createdAt), desc(leads.id));
    return params.limit !== undefined ? query.limit(params.limit).offset(params.offset ?? 0) : query;
  },

  /** How many leads `list` would return without paging (same conditions). */
  async count(params: LeadListParams) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(listCondition(params));
    return row.n;
  },

  /** Dashboard aggregates over the leads in scope: count per status, and leads created per day since `from`. */
  async stats(params: { organizationId: string; scope?: LeadScope; from: Date; timeZone: string }) {
    const where = and(eq(leads.organizationId, params.organizationId), scopeCondition(params.scope));
    const byStatus = await db
      .select({ status: leads.status, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(where)
      .groupBy(leads.status);
    const day = sql<string>`to_char(${leads.createdAt} at time zone ${params.timeZone}, 'YYYY-MM-DD')`;
    const daily = await db
      .select({ day, total: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(where, gte(leads.createdAt, params.from)))
      .groupBy(sql`1`) // positional: a repeated time-zone parameter would not match the select expression
      .orderBy(sql`1`);
    return { byStatus, daily };
  },

  async create(params: {
    organizationId: string;
    projectId: string;
    name: string;
    phone: string;
    requirementConfig?: string;
    budgetMin?: number;
    budgetMax?: number;
    assignedUserId?: string | null;
  }) {
    const rows = await db.insert(leads).values(params).returning();
    return rows[0];
  },

  /** Another lead in the same organization and project with this (normalized) phone. */
  /** Ids of the organization's leads with exactly this (normalized) phone number. */
  async findIdsByPhone(params: { organizationId: string; phone: string }): Promise<string[]> {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.organizationId, params.organizationId), eq(leads.phone, params.phone)));
    return rows.map((r) => r.id);
  },

  /** Names and phones for a set of lead ids (call lists); only leads of this organization are returned. */
  async findContactsByIds(params: { organizationId: string; ids: string[] }) {
    if (params.ids.length === 0) return [];
    return db
      .select({ id: leads.id, name: leads.name, phone: leads.phone })
      .from(leads)
      .where(and(eq(leads.organizationId, params.organizationId), inArray(leads.id, params.ids)));
  },

  async findDuplicate(params: { organizationId: string; projectId: string; phone: string; excludeId?: string }) {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.organizationId, params.organizationId),
          eq(leads.projectId, params.projectId),
          eq(leads.phone, params.phone),
          params.excludeId ? ne(leads.id, params.excludeId) : undefined,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Projects that contain at least one lead assigned to this user (used for an AGENT's project visibility). */
  async distinctProjectIdsAssignedTo(params: { organizationId: string; userId: string }) {
    const rows = await db
      .selectDistinct({ projectId: leads.projectId })
      .from(leads)
      .where(and(eq(leads.organizationId, params.organizationId), eq(leads.assignedUserId, params.userId)));
    return rows.map((r) => r.projectId);
  },

  async updateStatus(params: { organizationId: string; id: string; status: LeadStatus }) {
    const rows = await db
      .update(leads)
      .set({ status: params.status, updatedAt: new Date() })
      .where(and(eq(leads.organizationId, params.organizationId), eq(leads.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },

  async update(params: {
    organizationId: string;
    id: string;
    name?: string;
    phone?: string;
    projectId?: string;
    requirementConfig?: string;
    budgetMin?: number;
    budgetMax?: number;
    status?: LeadStatus;
  }) {
    const { id, organizationId, ...fields } = params;
    const rows = await db
      .update(leads)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(leads.organizationId, organizationId), eq(leads.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  async assign(params: { organizationId: string; id: string; assignedUserId: string | null }) {
    const rows = await db
      .update(leads)
      .set({ assignedUserId: params.assignedUserId, updatedAt: new Date() })
      .where(and(eq(leads.organizationId, params.organizationId), eq(leads.id, params.id)))
      .returning();
    return rows[0] ?? null;
  },
};
