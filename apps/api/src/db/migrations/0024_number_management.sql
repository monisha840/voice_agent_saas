-- 0024 number management (additive only): per-number routing switch, refused-attempt record and provider check
-- result on agent_phone_numbers; the line an inbound call arrived on (calls.line_number). No new table, no policy,
-- role or grant change: the existing tenant_isolation policy and the resolver's column grant are unchanged.
ALTER TABLE "agent_phone_numbers" ADD COLUMN "routing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "refused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "last_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "last_refused_reason" varchar(40);--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "last_refused_call_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "provider_status" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "provider_detail" varchar(300);--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "provider_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "line_number" varchar(32);--> statement-breakpoint
CREATE INDEX "calls_org_line_created_idx" ON "calls" USING btree ("organization_id","line_number","created_at");