DO $$ BEGIN
 CREATE TYPE "public"."usage_type" AS ENUM('call', 'call_seconds', 'ai_turn', 'site_visit');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'rera';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'loan';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'booking';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'maintenance';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"agent_name" varchar(80) DEFAULT 'Priya' NOT NULL,
	"company_name" varchar(160),
	"greeting" text,
	"disclosure_text" varchar(300),
	"language" varchar(16) DEFAULT 'en-IN' NOT NULL,
	"tone" varchar(30) DEFAULT 'professional' NOT NULL,
	"call_objective" text,
	"qualification_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"call_behaviour" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"site_visit_behaviour" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra_instructions" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" varchar(10) NOT NULL,
	"actor_user_id" uuid,
	"actor_source" varchar(40),
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid,
	"type" "usage_type" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"dedupe_key" varchar(120),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_configs_org_default_unique" ON "agent_configs" USING btree ("organization_id") WHERE "agent_configs"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_configs_project_unique" ON "agent_configs" USING btree ("organization_id","project_id") WHERE "agent_configs"."project_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_entity_idx" ON "audit_logs" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_action_idx" ON "audit_logs" USING btree ("organization_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_org_dedupe_unique" ON "usage_events" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_org_occurred_idx" ON "usage_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_org_type_idx" ON "usage_events" USING btree ("organization_id","type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_knowledge_project_category_unique" ON "project_knowledge" USING btree ("project_id","category");