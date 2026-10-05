/**
 * Drizzle schema for the MVP (Phase 1).
 *
 * Only the 6 tables required by MVP_IMPLEMENTATION_PLAN.md §3.
 * No tenant_id anywhere yet (single implicit demo tenant) — see plan §2
 * for why, and note that every column/shape below is written so a
 * `tenant_id` column can be added later without reshaping these tables.
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
} from "drizzle-orm/pg-core";

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

export const siteVisitStatusEnum = pgEnum("site_visit_status", [
  "booked",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  location: varchar("location", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectKnowledge = pgTable("project_knowledge", {
  id: uuid("id").defaultRandom().primaryKey(),
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
});

export const leads = pgTable("leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull(),
  requirementConfig: varchar("requirement_config", { length: 100 }),
  budgetMin: integer("budget_min"),
  budgetMax: integer("budget_max"),
  status: leadStatusEnum("status").notNull().default("NEW"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calls = pgTable("calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  providerCallId: varchar("provider_call_id", { length: 255 }),
  status: callStatusEnum("status").notNull().default("initiating"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  recordingUrl: text("recording_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  // Ordered array of { speaker, text, timestamp }.
  transcript: jsonb("transcript").notNull().default([]),
  summary: text("summary"),
  // Extracted structured fields (timeline, loan_required, notes, etc.).
  qualification: jsonb("qualification"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const siteVisits = pgTable("site_visits", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "restrict" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: siteVisitStatusEnum("status").notNull().default("booked"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
