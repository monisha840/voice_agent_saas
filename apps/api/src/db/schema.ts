/**
 * Drizzle schema.
 *
 * Started as the 6 MVP tables; the SaaS foundation adds users/sessions
 * (auth), organizations/memberships (multi-tenancy), roles, agent
 * configuration, audit logs and usage events, each in its own incremental
 * migration. Every tenant-owned table carries organization_id (see the
 * tenancy section) and composite foreign keys keep related rows in the same
 * organization at the database level.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Categories of approved project knowledge the AI may quote from. */
export const projectKnowledgeCategoryEnum = pgEnum("project_knowledge_category", [
  "pricing",
  "configurations",
  "amenities",
  "possession",
  "faq",
  "location",
  // Added with project management: structured, individually editable facts the AI may quote.
  "rera",
  "loan",
  "booking",
  "maintenance",
]);

/**
 * Trimmed lead lifecycle for the MVP demo flow. Includes a few states
 * (NO_ANSWER, BUSY, RETRY, DNC, VISITED, NO_SHOW) that the current demo
 * script does not exercise but that match the production lifecycle in
 * PROJECT_ARCHITECTURE.md, so the enum does not need to change shape later.
 */
export const leadStatusEnum = pgEnum("lead_status", [
  "NEW",
  "CALLING",
  "NO_ANSWER",
  "BUSY",
  "RETRY",
  "ANSWERED",
  "QUALIFICATION",
  "INTERESTED",
  "NOT_INTERESTED",
  "DNC",
  "VISIT_OFFERED",
  "VISIT_BOOKED",
  "CONFIRMED",
  "VISITED",
  "NO_SHOW",
  "FOLLOW_UP",
]);

export const callStatusEnum = pgEnum("call_status", [
  "initiating",
  "ringing",
  "in_progress",
  "completed",
  "failed",
]);

/** How a call came to exist: placed to someone (outbound), received (inbound) or launched from the Test page (test). */
export const callTypeEnum = pgEnum("call_type", ["outbound", "inbound", "test"]);

export const siteVisitStatusEnum = pgEnum("site_visit_status", [
  "booked",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 255 }).notNull(),
  location: varchar("location", { length: 255 }).notNull(),
  description: text("description"),
  /** "active" | "archived". Archived projects keep all history but accept no new calls or leads. */
  status: varchar("status", { length: 50 }).notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    orgIdUnique: unique("projects_org_id_id_unique").on(t.organizationId, t.id),
    orgIdx: index("projects_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const projectKnowledge = pgTable(
  "project_knowledge",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: projectKnowledgeCategoryEnum("category").notNull(),
  // Structured content for this knowledge category. Shape varies by
  // category (see seed script for examples) — the AI tool layer reads
  // this, never raw SQL, and never anything outside this table.
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    projectFk: foreignKey({
      name: "project_knowledge_org_project_fk",
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("cascade"),
    projectCategoryUnique: uniqueIndex("project_knowledge_project_category_unique").on(t.projectId, t.category),
    projectIdx: index("project_knowledge_project_idx").on(t.projectId),
    orgIdx: index("project_knowledge_org_idx").on(t.organizationId),
  }),
);

export const leads = pgTable(
  "leads",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull(),
  /** The team member responsible for this lead (null = unassigned). Must be a member of the same organization (checked in the service). */
  assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
  requirementConfig: varchar("requirement_config", { length: 100 }),
  budgetMin: integer("budget_min"),
  budgetMax: integer("budget_max"),
  status: leadStatusEnum("status").notNull().default("NEW"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    orgIdUnique: unique("leads_org_id_id_unique").on(t.organizationId, t.id),
    projectFk: foreignKey({
      name: "leads_org_project_fk",
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("restrict"),
    orgStatusIdx: index("leads_org_status_idx").on(t.organizationId, t.status),
    orgCreatedIdx: index("leads_org_created_idx").on(t.organizationId, t.createdAt),
    projectIdx: index("leads_project_idx").on(t.projectId),
    assignedIdx: index("leads_org_assigned_idx").on(t.organizationId, t.assignedUserId),
  }),
);

export const calls = pgTable(
  "calls",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  /** The agent that handled (or will handle) the call. Required (made NOT NULL by migration 0009 after the 0008 backfill). */
  agentId: uuid("agent_id").notNull(),
  /** Optional: only calls made through the Sales module are tied to a lead. */
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  callType: callTypeEnum("call_type").notNull().default("outbound"),
  /** The other party: the callee for outbound/test calls, the caller for inbound calls (E.164 when known). */
  counterpartyNumber: varchar("counterparty_number", { length: 32 }),
  counterpartyName: varchar("counterparty_name", { length: 255 }),
  initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  providerCallId: varchar("provider_call_id", { length: 255 }),
  status: callStatusEnum("status").notNull().default("initiating"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  recordingUrl: text("recording_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    orgIdUnique: unique("calls_org_id_id_unique").on(t.organizationId, t.id),
    // NOTE: the migration writes this as ON DELETE SET NULL (lead_id) so deleting a lead keeps the call
    // (a plain composite SET NULL would also try to null organization_id).
    leadFk: foreignKey({
      name: "calls_org_lead_fk",
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
    }).onDelete("set null"),
    agentFk: foreignKey({
      name: "calls_org_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("restrict"),
    agentIdx: index("calls_agent_idx").on(t.agentId),
    orgTypeIdx: index("calls_org_type_idx").on(t.organizationId, t.callType),
    providerCallUnique: uniqueIndex("calls_provider_call_id_unique").on(t.providerCallId),
    leadIdx: index("calls_lead_idx").on(t.leadId),
    orgCreatedIdx: index("calls_org_created_idx").on(t.organizationId, t.createdAt),
    statusIdx: index("calls_status_idx").on(t.status),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  // Ordered array of { speaker, text, timestamp }.
  transcript: jsonb("transcript").notNull().default([]),
  summary: text("summary"),
  // Extracted structured fields (timeline, loan_required, notes, etc.).
  qualification: jsonb("qualification"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    callFk: foreignKey({
      name: "conversations_org_call_fk",
      columns: [t.organizationId, t.callId],
      foreignColumns: [calls.organizationId, calls.id],
    }).onDelete("cascade"),
    callIdx: index("conversations_call_idx").on(t.callId),
  }),
);

export const siteVisits = pgTable(
  "site_visits",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: siteVisitStatusEnum("status").notNull().default("booked"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => ({
    leadFk: foreignKey({
      name: "site_visits_org_lead_fk",
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
    }).onDelete("cascade"),
    projectFk: foreignKey({
      name: "site_visits_org_project_fk",
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("restrict"),
    leadIdx: index("site_visits_lead_idx").on(t.leadId),
    orgScheduledIdx: index("site_visits_org_scheduled_idx").on(t.organizationId, t.scheduledAt),
  }),
);

// ---------------------------------------------------------------------------
// Auth (Phase 1)
// ---------------------------------------------------------------------------

/**
 * A person who can sign in. Users are global (one account can belong to
 * several organizations via memberships). Email is stored lower-cased.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** scrypt hash string (see auth/password.ts). Never returned by any API. */
    passwordHash: text("password_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

/**
 * Server-side login sessions. The cookie holds a random token; only its
 * SHA-256 hash is stored, so a database leak cannot be replayed as cookies.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The organization this login is currently working in (users can belong to several). */
    activeOrganizationId: uuid("active_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    userIdx: index("sessions_user_id_idx").on(t.userId),
    expiresIdx: index("sessions_expires_at_idx").on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Multi-tenancy (Phase 2)
// ---------------------------------------------------------------------------

/** A customer company. Every tenant-owned row below belongs to exactly one. */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    /** URL-safe unique handle. */
    slug: varchar("slug", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("organizations_slug_unique").on(t.slug),
  }),
);

/**
 * Which optional feature packs ("modules") an organization has switched on.
 * The Voice AI core is always on and is not stored here; a module is available
 * to an organization only if it has a row with enabled = true (a missing row
 * means disabled). Disabling a module never deletes that module's data.
 */
export const organizationModules = pgTable(
  "organization_modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Registry key, e.g. "sales" (see modules/modules/module-registry.ts). */
    moduleKey: varchar("module_key", { length: 50 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Module-specific settings; the shape is owned by the module. */
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgModuleUnique: uniqueIndex("organization_modules_org_module_unique").on(t.organizationId, t.moduleKey),
  }),
);

export const orgRoleEnum = pgEnum("org_role", ["OWNER", "ADMIN", "MANAGER", "AGENT"]);

/** Which users belong to which organization, and with which role. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgUserUnique: uniqueIndex("memberships_org_user_unique").on(t.organizationId, t.userId),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Roles & access (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Which projects a MANAGER or AGENT works on. OWNER/ADMIN see every project
 * in the organization; MANAGERs see (and manage) only the projects listed here.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectFk: foreignKey({
      name: "project_members_org_project_fk",
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("cascade"),
    projectUserUnique: uniqueIndex("project_members_project_user_unique").on(t.projectId, t.userId),
    userIdx: index("project_members_user_idx").on(t.organizationId, t.userId),
  }),
);

/** Invite-only sign-up: an owner/admin invites an email address to join with a role. */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: orgRoleEnum("role").notNull(),
    /** SHA-256 of the invite token; the token itself is shown once and never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("invitations_token_hash_unique").on(t.tokenHash),
    orgIdx: index("invitations_org_idx").on(t.organizationId, t.email),
  }),
);

// ---------------------------------------------------------------------------
// Agent configuration (Phase 5)
// ---------------------------------------------------------------------------

/**
 * How the AI sales agent behaves, per organization (project_id NULL = the
 * organization default) or per project (overrides the default). Provider-
 * independent: language is a BCP-47 code, tone/behaviour are plain settings;
 * nothing here names Sarvam, Exotel or any model. The AI disclosure is NOT
 * configurable: the system always makes the agent say it is an AI assistant.
 * `disclosureText` may only customize the WORDING (validated to still say so).
 */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id"),
    agentName: varchar("agent_name", { length: 80 }).notNull().default("Priya"),
    companyName: varchar("company_name", { length: 160 }),
    greeting: text("greeting"),
    disclosureText: varchar("disclosure_text", { length: 300 }),
    language: varchar("language", { length: 16 }).notNull().default("en-IN"),
    tone: varchar("tone", { length: 30 }).notNull().default("professional"),
    callObjective: text("call_objective"),
    /** string[] — at most a few qualification questions the agent asks. */
    qualificationQuestions: jsonb("qualification_questions").notNull().default([]),
    /** object — e.g. { maxResponseSentences, maxQualificationQuestions, endCallWhenDone }. */
    callBehaviour: jsonb("call_behaviour").notNull().default({}),
    /** string[] of AI tool names the agent may use. */
    allowedTools: jsonb("allowed_tools").notNull().default([]),
    /** object — e.g. { offerSlots, autoBook, visitDurationMinutes }. */
    siteVisitBehaviour: jsonb("site_visit_behaviour").notNull().default({}),
    extraInstructions: text("extra_instructions"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectFk: foreignKey({
      name: "agent_configs_org_project_fk",
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }).onDelete("cascade"),
    orgDefaultUnique: uniqueIndex("agent_configs_org_default_unique")
      .on(t.organizationId)
      .where(sql`${t.projectId} is null`),
    projectUnique: uniqueIndex("agent_configs_project_unique")
      .on(t.organizationId, t.projectId)
      .where(sql`${t.projectId} is not null`),
  }),
);

// ---------------------------------------------------------------------------
// Agents (agent-first refactor)
// ---------------------------------------------------------------------------

/**
 * A configured voice agent: persona, prompt template, tools and behaviour.
 * Core Voice AI owns this table; nothing here depends on leads, projects or
 * site visits. Sales-specific knobs live in `moduleConfig.sales` and sales
 * knowledge sources are attached through `agent_knowledge_bindings`.
 * `voice` is stored only (null = provider default); it is not wired to any provider yet.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Internal label shown in the dashboard. */
    name: varchar("name", { length: 120 }).notNull(),
    /** The name the agent speaks as. */
    personaName: varchar("persona_name", { length: 80 }).notNull(),
    /** Optional; never defaulted to any brand. */
    companyName: varchar("company_name", { length: 160 }),
    description: text("description"),
    /** "active" | "archived". */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    /** "generic" | "sales_real_estate". */
    promptTemplateKey: varchar("prompt_template_key", { length: 40 }).notNull().default("generic"),
    systemPrompt: text("system_prompt"),
    extraInstructions: text("extra_instructions"),
    callObjective: text("call_objective"),
    greeting: text("greeting"),
    disclosureText: varchar("disclosure_text", { length: 300 }),
    language: varchar("language", { length: 16 }).notNull().default("en-IN"),
    voice: varchar("voice", { length: 80 }),
    tone: varchar("tone", { length: 30 }).notNull().default("professional"),
    /** { maxResponseSentences, endCallWhenDone, conversationQuestions }. */
    behaviour: jsonb("behaviour").notNull().default({}),
    /** string[] of tool names; explicit and always includes "end_call". */
    enabledTools: jsonb("enabled_tools").notNull().default([]),
    /** Module-owned settings, e.g. { sales: { offerSlots, autoBook } }. */
    moduleConfig: jsonb("module_config").notNull().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("agents_org_id_id_unique").on(t.organizationId, t.id),
    defaultUnique: uniqueIndex("agents_org_default_unique")
      .on(t.organizationId)
      .where(sql`${t.isDefault} and ${t.status} = 'active'`),
    nameUnique: uniqueIndex("agents_org_name_unique")
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
    orgStatusIdx: index("agents_org_status_idx").on(t.organizationId, t.status),
  }),
);

/**
 * Attaches a knowledge source to an agent. `sourceType` is owned by a module
 * ("project" belongs to Sales); there is deliberately no FK on `sourceId`, the
 * service validates it against the owning module.
 */
export const agentKnowledgeBindings = pgTable(
  "agent_knowledge_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").notNull(),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentFk: foreignKey({
      name: "agent_knowledge_bindings_org_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    sourceUnique: unique("agent_knowledge_bindings_agent_source_unique").on(t.agentId, t.sourceType, t.sourceId),
    sourceIdx: index("agent_knowledge_bindings_source_idx").on(t.organizationId, t.sourceType, t.sourceId),
  }),
);

// ---------------------------------------------------------------------------
// Audit log + usage events (Phases 7 and 8)
// ---------------------------------------------------------------------------

/** Append-only record of important actions. Never updated or deleted by the application. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorType: varchar("actor_type", { length: 10 }).notNull(), // "user" | "system"
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** For system actors: which flow (exotel-webhook, ai-tool, reaper, ...). */
    actorSource: varchar("actor_source", { length: 40 }),
    /** Dotted verb, e.g. "project.created", "lead.updated", "user.role_changed". */
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: uuid("entity_id"),
    /** Sanitized details (secrets are stripped before insert). */
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
    orgEntityIdx: index("audit_logs_org_entity_idx").on(t.organizationId, t.entityType, t.entityId),
    orgActionIdx: index("audit_logs_org_action_idx").on(t.organizationId, t.action),
  }),
);

export const usageTypeEnum = pgEnum("usage_type", ["call", "call_seconds", "ai_turn", "site_visit"]);

/**
 * Append-only usage ledger for future billing (no billing logic yet).
 * `dedupeKey` makes recording idempotent: the same call finalized twice, or a
 * retried webhook, can never double-count (unique per organization).
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    callId: uuid("call_id"),
    type: usageTypeEnum("type").notNull(),
    quantity: integer("quantity").notNull().default(1),
    dedupeKey: varchar("dedupe_key", { length: 120 }),
    metadata: jsonb("metadata").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    callFk: foreignKey({
      name: "usage_events_org_call_fk",
      columns: [t.organizationId, t.callId],
      foreignColumns: [calls.organizationId, calls.id],
    }).onDelete("cascade"),
    dedupeUnique: uniqueIndex("usage_events_org_dedupe_unique").on(t.organizationId, t.dedupeKey),
    orgOccurredIdx: index("usage_events_org_occurred_idx").on(t.organizationId, t.occurredAt),
    orgTypeIdx: index("usage_events_org_type_idx").on(t.organizationId, t.type, t.occurredAt),
  }),
);

// ---------------------------------------------------------------------------
// Inbound routing
// ---------------------------------------------------------------------------

/**
 * Which agent answers a dialed number. Provider-agnostic: the number is plain E.164. A number belongs to
 * exactly one agent anywhere (globally unique), so an inbound call can be routed with no login.
 */
export const agentPhoneNumbers = pgTable(
  "agent_phone_numbers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").notNull(),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    label: varchar("label", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentFk: foreignKey({
      name: "agent_phone_numbers_org_agent_fk",
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete("cascade"),
    numberUnique: uniqueIndex("agent_phone_numbers_number_unique").on(t.phoneNumber),
    agentIdx: index("agent_phone_numbers_agent_idx").on(t.agentId),
  }),
);
