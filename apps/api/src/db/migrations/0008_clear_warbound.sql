DO $$ BEGIN
 CREATE TYPE "public"."call_type" AS ENUM('outbound', 'inbound', 'test');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"phone_number" varchar(32) NOT NULL,
	"label" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT IF EXISTS "calls_org_lead_fk";
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "call_type" "call_type" DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "counterparty_number" varchar(32);--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "counterparty_name" varchar(255);--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "initiated_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_phone_numbers" ADD CONSTRAINT "agent_phone_numbers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_phone_numbers" ADD CONSTRAINT "agent_phone_numbers_org_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_phone_numbers_number_unique" ON "agent_phone_numbers" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_phone_numbers_agent_idx" ON "agent_phone_numbers" USING btree ("agent_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_org_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_org_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE set null ("lead_id") ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_agent_idx" ON "calls" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_org_type_idx" ON "calls" USING btree ("organization_id","call_type");
--> statement-breakpoint
-- Expand/contract, step 1 of 2. agent_id stays NULLABLE here (migration 0009 makes it required once the new code
-- path is verified). Deleting a lead now keeps its calls (lead_id is set to NULL, organization_id is untouched).

-- Backfill: attribute every existing call to the agent that handled it. The legacy rule was "the config of the lead's
-- project, else the organization default", which maps to: the active agent bound to the lead's project, else the
-- organization's default agent.
UPDATE "calls" c SET "agent_id" = COALESCE(
  (SELECT b."agent_id"
     FROM "leads" l
     JOIN "agent_knowledge_bindings" b
       ON b."organization_id" = l."organization_id" AND b."source_type" = 'project' AND b."source_id" = l."project_id"
     JOIN "agents" a ON a."organization_id" = b."organization_id" AND a."id" = b."agent_id" AND a."status" = 'active'
    WHERE l."organization_id" = c."organization_id" AND l."id" = c."lead_id"
    ORDER BY a."created_at", a."id"
    LIMIT 1),
  (SELECT a."id" FROM "agents" a
    WHERE a."organization_id" = c."organization_id" AND a."is_default" AND a."status" = 'active'
    LIMIT 1)
)
WHERE c."agent_id" IS NULL;
--> statement-breakpoint
-- The counterparty of every existing call is its lead (the callee of an outbound call).
UPDATE "calls" c SET "counterparty_number" = l."phone", "counterparty_name" = l."name"
  FROM "leads" l
 WHERE l."organization_id" = c."organization_id" AND l."id" = c."lead_id"
   AND c."counterparty_number" IS NULL;
