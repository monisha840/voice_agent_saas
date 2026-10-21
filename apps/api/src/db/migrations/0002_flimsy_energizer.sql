DO $$ BEGIN
 CREATE TYPE "public"."org_role" AS ENUM('OWNER', 'ADMIN', 'MANAGER', 'AGENT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "project_knowledge" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_org_user_unique" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Backfill (hand-written). Runs ONLY when pre-tenancy data exists, so a fresh
-- database does not get a stray demo organization. Every existing row is attached
-- to the Demo Organization THROUGH its relationships (project -> lead -> call ->
-- conversation, lead -> site visit), never by a blanket default.
-- ---------------------------------------------------------------------------
INSERT INTO "organizations" ("name", "slug")
SELECT 'Demo Organization', 'demo'
WHERE EXISTS (SELECT 1 FROM "projects")
  AND NOT EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'demo');
--> statement-breakpoint
UPDATE "projects" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'demo')
WHERE "organization_id" IS NULL;
--> statement-breakpoint
UPDATE "project_knowledge" pk SET "organization_id" = p."organization_id"
FROM "projects" p WHERE pk."project_id" = p."id" AND pk."organization_id" IS NULL;
--> statement-breakpoint
UPDATE "leads" l SET "organization_id" = p."organization_id"
FROM "projects" p WHERE l."project_id" = p."id" AND l."organization_id" IS NULL;
--> statement-breakpoint
UPDATE "calls" c SET "organization_id" = l."organization_id"
FROM "leads" l WHERE c."lead_id" = l."id" AND c."organization_id" IS NULL;
--> statement-breakpoint
UPDATE "conversations" v SET "organization_id" = c."organization_id"
FROM "calls" c WHERE v."call_id" = c."id" AND v."organization_id" IS NULL;
--> statement-breakpoint
UPDATE "site_visits" sv SET "organization_id" = l."organization_id"
FROM "leads" l WHERE sv."lead_id" = l."id" AND sv."organization_id" IS NULL;
--> statement-breakpoint
-- The seeded demo user owns the demo organization (if both exist).
INSERT INTO "memberships" ("organization_id", "user_id", "role")
SELECT o."id", u."id", 'OWNER'
FROM "organizations" o JOIN "users" u ON u."email" = 'demo@greenvalley.demo'
WHERE o."slug" = 'demo'
ON CONFLICT DO NOTHING;
