CREATE TABLE IF NOT EXISTS "organization_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"module_key" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_modules_org_module_unique" ON "organization_modules" USING btree ("organization_id","module_key");--> statement-breakpoint
-- Backfill: every organization that exists today already uses the sales features, so it keeps them.
INSERT INTO "organization_modules" ("organization_id", "module_key", "enabled")
SELECT "id", 'sales', true FROM "organizations"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
