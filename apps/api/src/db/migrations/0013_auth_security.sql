CREATE TABLE IF NOT EXISTS "auth_throttle" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"event_type" varchar(80) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(256),
	"request_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_auth_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_step" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_events" ADD CONSTRAINT "security_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_events" ADD CONSTRAINT "security_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_recovery_codes_hash_unique" ON "mfa_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_org_created_idx" ON "security_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_user_created_idx" ON "security_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_type_created_idx" ON "security_events" USING btree ("event_type","created_at");--> statement-breakpoint

-- security_events: append-only for the runtime role. Organization-scoped rows are visible to that organization;
-- organization-less rows (e.g. a failed login) only to the user they concern. Writes must be organization-less or
-- for the active organization, so a request can never forge an event into another tenant.
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS security_events_select ON security_events;
--> statement-breakpoint
DROP POLICY IF EXISTS security_events_insert ON security_events;
--> statement-breakpoint
CREATE POLICY security_events_select ON security_events FOR SELECT
  USING (
    organization_id = (SELECT app_current_org())
    OR (organization_id IS NULL AND actor_user_id IS NOT NULL AND actor_user_id = (SELECT app_current_user()))
  );
--> statement-breakpoint
CREATE POLICY security_events_insert ON security_events FOR INSERT
  WITH CHECK (organization_id IS NULL OR organization_id = (SELECT app_current_org()));
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON security_events FROM voice_app;
--> statement-breakpoint
-- Throttle counters and MFA recovery hashes hold no tenant data; the runtime role maintains them.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle, mfa_recovery_codes TO voice_app;
