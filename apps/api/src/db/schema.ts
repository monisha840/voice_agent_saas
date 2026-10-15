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
  bigint,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  index,
  uniqueIndex,
  foreignKey,
  unique,
  customType,
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
  // What a caller asks beyond price and size: what is nearby, approvals, who builds it, and the project in the builder's words.
  "nearby",
  "approvals",
  "builder",
  "about",
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
  /** Our number the call came in on (inbound: the dialed number, E.164). Kept when the number is later removed. */
  lineNumber: varchar("line_number", { length: 32 }),
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
    orgLineIdx: index("calls_org_line_created_idx").on(t.organizationId, t.lineNumber, t.createdAt),
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

/**
 * Something a person on the team must do after a call: ring the lead back at a time they asked for, answer a question
 * the agent could not, or get on the line because the lead asked for a human. Written by the agent during the call
 * (the request_follow_up tool) and cleared by a team member. A lead's own status is never changed by it, except that a
 * do_not_call request also sets the lead to DNC.
 */
export const followUps = pgTable(
  "follow_ups",
  {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  /** The lead concerned; null for a call that had no lead (e.g. an unknown inbound caller). */
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  /** The call it came from; kept when the call is deleted. */
  callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
  /** human_requested | callback | info_requested | do_not_call (validated in the service). */
  kind: varchar("kind", { length: 24 }).notNull(),
  note: text("note"),
  /** When the lead asked to be called, if they said. */
  dueAt: timestamp("due_at", { withTimezone: true }),
  /** open | done */
  status: varchar("status", { length: 12 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
},
  (t) => ({
    leadFk: foreignKey({
      name: "follow_ups_org_lead_fk",
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
    }).onDelete("cascade"),
    orgStatusIdx: index("follow_ups_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    leadIdx: index("follow_ups_lead_idx").on(t.leadId),
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
    /** When the password was last set; sessions older than this can never be resumed. */
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    /** TOTP secret, AES-256-GCM encrypted (auth/secret-box.ts). Null = MFA not enrolled. Never returned by any API. */
    mfaSecretEnc: text("mfa_secret_enc"),
    /** Set once the user proved possession of the authenticator (enrollment confirmed). */
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    /** Last accepted TOTP time step: a code is single-use (replay protection). */
    mfaLastStep: bigint("mfa_last_step", { mode: "number" }),
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
    /** When the user last proved their password (login or re-authentication): gates sensitive actions. */
    lastAuthAt: timestamp("last_auth_at", { withTimezone: true }).notNull().defaultNow(),
    /** When this session passed the second factor. Null on an MFA account = the session is not yet usable. */
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
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
    /** Paused numbers stay assigned but inbound calls on them are refused (number management, migration 0024). */
    routingEnabled: boolean("routing_enabled").notNull().default(true),
    /** Last inbound call accepted on this number. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    /** Inbound attempts refused on this number (paused, agent not active, organization limit, ...). */
    refusedCount: integer("refused_count").notNull().default(0),
    lastRefusedAt: timestamp("last_refused_at", { withTimezone: true }),
    lastRefusedReason: varchar("last_refused_reason", { length: 40 }),
    /** Provider call id of the last refused attempt: a retried webhook for the same call is not counted twice. */
    lastRefusedCallId: varchar("last_refused_call_id", { length: 255 }),
    /** Result of the last provider-side check of this number ("verified" | "not_found" | "error" | "unsupported"). */
    providerStatus: varchar("provider_status", { length: 20 }),
    providerDetail: varchar("provider_detail", { length: 300 }),
    providerCheckedAt: timestamp("provider_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

// ---------------------------------------------------------------------------
// Authentication security (MFA recovery, security audit trail, shared login throttling)
// ---------------------------------------------------------------------------

/** Single-use MFA recovery codes. Only a SHA-256 of each code is stored. */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("mfa_recovery_codes_user_idx").on(t.userId),
    hashUnique: uniqueIndex("mfa_recovery_codes_hash_unique").on(t.userId, t.codeHash),
  }),
);

/**
 * Append-only authentication and security events (logins, lockouts, MFA, session revocation, access denials,
 * privileged system actions). organization_id is null for events that happen before an organization is known
 * (a failed login). Never holds secrets, tokens, passwords or request bodies.
 */
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Dotted verb, e.g. "auth.login.failed", "auth.mfa.enrolled", "session.revoked". */
    eventType: varchar("event_type", { length: 80 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(), // success | failure | denied | info
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 256 }),
    requestId: varchar("request_id", { length: 64 }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("security_events_org_created_idx").on(t.organizationId, t.createdAt),
    userCreatedIdx: index("security_events_user_created_idx").on(t.actorUserId, t.createdAt),
    typeCreatedIdx: index("security_events_type_created_idx").on(t.eventType, t.createdAt),
  }),
);

/**
 * How many media-stream connections each per-call token has opened (replay / reuse limit shared across API
 * instances). Rows are keyed by the token's random id; they hold no tenant data and expire with the token.
 */
export const streamTokenUses = pgTable(
  "stream_token_uses",
  {
    jti: varchar("jti", { length: 64 }).primaryKey(),
    callId: uuid("call_id").notNull(),
    uses: integer("uses").notNull().default(0),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("stream_token_uses_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Cross-instance "one media stream per call" claim. A live stream refreshes `heartbeat_at`; a claim whose heartbeat is
 * stale (crashed instance) can be taken over. Holds only ids: no tenant data, no organization_id, no RLS.
 */
export const streamClaims = pgTable(
  "stream_claims",
  {
    callId: uuid("call_id").primaryKey(),
    instanceId: varchar("instance_id", { length: 64 }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    heartbeatIdx: index("stream_claims_heartbeat_idx").on(t.heartbeatAt),
  }),
);

/**
 * Short opaque per-call stream grants minted by the dynamic Voicebot endpoint (opt-in; security/stream-grant.ts).
 * Only sha256(grant) is stored. No organization_id on purpose: the owning organization is always read from the call
 * record this row points at, so the table holds no tenant data (ids + counters) and is classified operational.
 */
export const streamGrants = pgTable(
  "stream_grants",
  {
    grantHash: varchar("grant_hash", { length: 64 }).primaryKey(),
    callId: uuid("call_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index("stream_grants_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Shared (database-backed, so every API instance sees the same counters) failed-login throttle. The key is a
 * SHA-256 of "ip:<address>", "acct:<email>" or "pair:<email>|<address>": no plaintext identifiers are stored.
 */
export const authThrottle = pgTable("auth_throttle", {
  key: varchar("key", { length: 64 }).primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Shared fixed-window rate-limit counters (one row per key, multi-instance safe). `key` is a SHA-256 hex of
 * "<scope>|<identifier>" so no plaintext IP, email or user id is stored. The window restarts on the first hit after it
 * expires; stale rows are purged by the security janitor. Operational table: no tenant data, no RLS.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    windowIdx: index("rate_limit_buckets_window_idx").on(t.windowStart),
  }),
);

// ---------------------------------------------------------------------------
// Billing foundation (migration 0019): plan catalog, tenant subscriptions, metered usage ledger, payment events.
// See docs/billing/README.md. No payment credentials are ever stored here.
// ---------------------------------------------------------------------------

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "suspended",
  "canceled",
  "expired",
]);

export const usageLedgerStateEnum = pgEnum("usage_ledger_state", ["pending", "final", "superseded"]);

/**
 * The plan catalog: configuration, not tenant state. Global reference data (no organization_id, no RLS); the runtime
 * role can only read it. Prices are integer paise (NULL = custom/negotiated). Seeded by the migration; changed by
 * operators with the owner connection, never by the application.
 */
export const plans = pgTable("plans", {
  key: varchar("key", { length: 40 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description").notNull().default(""),
  pricePaise: integer("price_paise"),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),
  billingInterval: varchar("billing_interval", { length: 10 }).notNull().default("month"),
  includedMinutes: integer("included_minutes").notNull().default(0),
  trialDays: integer("trial_days"),
  /** maxConcurrentCalls, maxAgents, maxTeamMembers, retentionDays, analytics, apiAccess, webhooks (validated in code). */
  entitlements: jsonb("entitlements").notNull().default({}),
  isPublic: boolean("is_public").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A tenant's subscription state (one row per organization). Organizations without a row are unmanaged (legacy). */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    planKey: varchar("plan_key", { length: 40 })
      .notNull()
      .references(() => plans.key, { onDelete: "restrict" }),
    status: subscriptionStatusEnum("status").notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /** A plan change requested but not yet effective (needs a verified payment or a sales decision). */
    scheduledPlanKey: varchar("scheduled_plan_key", { length: 40 }),
    /** Negotiated overrides of the plan's entitlements (e.g. Enterprise). Same keys as plans.entitlements + includedMinutes. */
    limitOverrides: jsonb("limit_overrides").notNull().default({}),
    paymentProvider: varchar("payment_provider", { length: 40 }),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgUnique: uniqueIndex("subscriptions_org_unique").on(t.organizationId),
    statusIdx: index("subscriptions_status_idx").on(t.status),
  }),
);

/**
 * Metered call usage, append-only. One row per call (idempotency key `call:<callId>`); a correction is a NEW row that
 * supersedes the original (the original is only ever marked `superseded`). A trigger (migration 0019) rejects any
 * other update or any delete, so history cannot be rewritten silently.
 */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    callId: uuid("call_id"),
    providerCallId: varchar("provider_call_id", { length: 255 }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    /** call_lifecycle | reconciliation | correction | mock */
    source: varchar("source", { length: 30 }).notNull(),
    entryType: varchar("entry_type", { length: 12 }).notNull().default("call"), // call | correction
    state: usageLedgerStateEnum("state").notNull().default("final"),
    supersedesId: uuid("supersedes_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    billableSeconds: integer("billable_seconds").notNull().default(0),
    billableMinutes: integer("billable_minutes").notNull().default(0),
    roundingPolicy: varchar("rounding_policy", { length: 40 }).notNull(),
    /** billed | unanswered | failed | too_short | test_call | interrupted | corrected */
    billableReason: varchar("billable_reason", { length: 30 }).notNull(),
    outcome: varchar("outcome", { length: 30 }).notNull(),
    terminationReason: varchar("termination_reason", { length: 100 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("usage_ledger_org_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    orgOccurredIdx: index("usage_ledger_org_occurred_idx").on(t.organizationId, t.occurredAt),
    orgCallIdx: index("usage_ledger_org_call_idx").on(t.organizationId, t.callId),
  }),
);

/** Verified payment-provider events, for idempotent handling (no card data; payload digest only). */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 40 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    outcome: varchar("outcome", { length: 20 }).notNull(), // applied | ignored
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventUnique: uniqueIndex("billing_events_provider_event_unique").on(t.provider, t.providerEventId),
    orgIdx: index("billing_events_org_idx").on(t.organizationId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Knowledge base (migration 0023): reusable, organization-owned knowledge (FAQs, business information, uploaded text
// documents split into passages) that agents are bound to through agent_knowledge_bindings (source_type
// "knowledge_base") and search during a conversation with the core `search_knowledge` tool.
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    /** "active" | "archived". Archived knowledge is never searched. */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("knowledge_bases_org_id_id_unique").on(t.organizationId, t.id),
    nameUnique: uniqueIndex("knowledge_bases_org_name_unique")
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    knowledgeBaseId: uuid("knowledge_base_id").notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** SHA-256 of the uploaded bytes (duplicate detection, audit). The bytes themselves are not stored. */
    sha256: varchar("sha256", { length: 64 }).notNull(),
    /** "processing" | "ready" | "failed". */
    status: varchar("status", { length: 20 }).notNull().default("processing"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("knowledge_documents_org_id_id_unique").on(t.organizationId, t.id),
    kbFk: foreignKey({
      name: "knowledge_documents_org_kb_fk",
      columns: [t.organizationId, t.knowledgeBaseId],
      foreignColumns: [knowledgeBases.organizationId, knowledgeBases.id],
    }).onDelete("cascade"),
    kbIdx: index("knowledge_documents_kb_idx").on(t.organizationId, t.knowledgeBaseId),
  }),
);

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    knowledgeBaseId: uuid("knowledge_base_id").notNull(),
    /** Set for passages extracted from an uploaded document (deleted with it). */
    documentId: uuid("document_id"),
    /** "faq" (title = question, body = answer) | "info" (title = topic) | "document" (a passage of a document). */
    kind: varchar("kind", { length: 20 }).notNull(),
    title: varchar("title", { length: 300 }).notNull().default(""),
    body: text("body").notNull(),
    position: integer("position").notNull().default(0),
    /** Full-text index of title + body ('simple' configuration: no language-specific stemming, works for any script). */
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kbFk: foreignKey({
      name: "knowledge_items_org_kb_fk",
      columns: [t.organizationId, t.knowledgeBaseId],
      foreignColumns: [knowledgeBases.organizationId, knowledgeBases.id],
    }).onDelete("cascade"),
    docFk: foreignKey({
      name: "knowledge_items_org_document_fk",
      columns: [t.organizationId, t.documentId],
      foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id],
    }).onDelete("cascade"),
    kbIdx: index("knowledge_items_kb_idx").on(t.organizationId, t.knowledgeBaseId, t.position),
    searchIdx: index("knowledge_items_search_idx").using("gin", t.search),
  }),
);
