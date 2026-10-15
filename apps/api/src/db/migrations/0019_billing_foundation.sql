CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'suspended', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."usage_ledger_state" AS ENUM('pending', 'final', 'superseded');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(40) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_paise" integer,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"billing_interval" varchar(10) DEFAULT 'month' NOT NULL,
	"included_minutes" integer DEFAULT 0 NOT NULL,
	"trial_days" integer,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_key" varchar(40) NOT NULL,
	"status" "subscription_status" NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"scheduled_plan_key" varchar(40),
	"limit_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payment_provider" varchar(40),
	"provider_subscription_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid,
	"provider_call_id" varchar(255),
	"idempotency_key" varchar(160) NOT NULL,
	"source" varchar(30) NOT NULL,
	"entry_type" varchar(12) DEFAULT 'call' NOT NULL,
	"state" "usage_ledger_state" DEFAULT 'final' NOT NULL,
	"supersedes_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"billable_seconds" integer DEFAULT 0 NOT NULL,
	"billable_minutes" integer DEFAULT 0 NOT NULL,
	"rounding_policy" varchar(40) NOT NULL,
	"billable_reason" varchar(30) NOT NULL,
	"outcome" varchar(30) NOT NULL,
	"termination_reason" varchar(100),
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_unique" ON "billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_idx" ON "billing_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_unique" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_org_idempotency_unique" ON "usage_ledger" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_org_occurred_idx" ON "usage_ledger" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_org_call_idx" ON "usage_ledger" USING btree ("organization_id","call_id");
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------------------------
-- Billing foundation (hand-written part; the DDL above is drizzle-kit output). ADDITIVE: no existing table, policy,
-- role or function is altered. Existing organizations get NO subscription row and keep today's behaviour
-- ("unmanaged"). Self-service organization creation is NOT part of this migration (see docs/billing/README.md).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_nonnegative" CHECK (price_paise IS NULL OR price_paise >= 0);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_minutes_nonnegative" CHECK (included_minutes >= 0);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_order" CHECK (current_period_end > current_period_start);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_nonnegative" CHECK (duration_seconds >= 0 AND billable_seconds >= 0 AND billable_minutes >= 0);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_entry_type" CHECK (entry_type IN ('call', 'correction'));--> statement-breakpoint

-- Tenant isolation: the same policy shape as every other tenant-owned table (migration 0012).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'usage_ledger', 'billing_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (organization_id = (SELECT app_current_org())) WITH CHECK (organization_id = (SELECT app_current_org()))',
      t
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- The catalog is configuration: the runtime can read it and never write it.
REVOKE INSERT, UPDATE, DELETE ON plans FROM voice_app;--> statement-breakpoint
-- The ledger and event log are append-only for the runtime (the trigger below also enforces it for every role).
REVOKE DELETE ON usage_ledger FROM voice_app;--> statement-breakpoint
REVOKE DELETE ON billing_events FROM voice_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION usage_ledger_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage_ledger rows are append-only (corrections supersede, they never delete)';
  END IF;
  -- Only the lifecycle state may change, and only forward: pending -> final -> superseded.
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'usage_ledger rows are immutable except for their state';
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('pending', 'final', 'superseded'))
    OR (OLD.state = 'final' AND NEW.state IN ('final', 'superseded'))
    OR (OLD.state = 'superseded' AND NEW.state = 'superseded')
  ) THEN
    RAISE EXCEPTION 'usage_ledger state cannot move from % to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS usage_ledger_guard_trg ON usage_ledger;--> statement-breakpoint
CREATE TRIGGER usage_ledger_guard_trg BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION usage_ledger_guard();--> statement-breakpoint

-- Provisional plan catalog (business assumptions, NOT approved pricing). Prices in paise. Re-runnable.
INSERT INTO plans (key, name, description, price_paise, included_minutes, trial_days, entitlements, is_public, sort_order) VALUES
  ('trial', 'Trial', 'Evaluate the platform with a small allowance of call minutes.', 0, 30, 14,
   '{"maxConcurrentCalls":1,"maxAgents":1,"maxTeamMembers":3,"retentionDays":14,"analytics":"basic","apiAccess":false,"webhooks":false}', false, 0),
  ('starter', 'Starter', 'For a single team getting its first voice agent live.', 299900, 300, NULL,
   '{"maxConcurrentCalls":3,"maxAgents":3,"maxTeamMembers":5,"retentionDays":30,"analytics":"basic","apiAccess":false,"webhooks":false}', true, 10),
  ('growth', 'Growth', 'For growing teams running several agents.', 1499900, 2000, NULL,
   '{"maxConcurrentCalls":10,"maxAgents":10,"maxTeamMembers":15,"retentionDays":90,"analytics":"advanced","apiAccess":true,"webhooks":true}', true, 20),
  ('business', 'Business', 'For high-volume operations.', 4999900, 8000, NULL,
   '{"maxConcurrentCalls":30,"maxAgents":30,"maxTeamMembers":50,"retentionDays":365,"analytics":"advanced","apiAccess":true,"webhooks":true}', true, 30),
  ('enterprise', 'Enterprise', 'Custom pricing and negotiated limits.', NULL, 0, NULL, '{}', true, 40)
ON CONFLICT (key) DO NOTHING;
