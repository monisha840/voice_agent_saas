ALTER TABLE "calls" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_knowledge" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "site_visits" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_org_id_id_unique" UNIQUE("organization_id","id");
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_id_unique" UNIQUE("organization_id","id");
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_id_unique" UNIQUE("organization_id","id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_org_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."calls"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_org_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calls_provider_call_id_unique" ON "calls" USING btree ("provider_call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_lead_idx" ON "calls" USING btree ("lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_org_created_idx" ON "calls" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_status_idx" ON "calls" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_call_idx" ON "conversations" USING btree ("call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_status_idx" ON "leads" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_created_idx" ON "leads" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_project_idx" ON "leads" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_knowledge_project_idx" ON "project_knowledge" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_knowledge_org_idx" ON "project_knowledge" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_org_status_idx" ON "projects" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_visits_lead_idx" ON "site_visits" USING btree ("lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_visits_org_scheduled_idx" ON "site_visits" USING btree ("organization_id","scheduled_at");
