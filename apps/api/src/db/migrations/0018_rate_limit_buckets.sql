CREATE TABLE "rate_limit_buckets" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_idx" ON "rate_limit_buckets" USING btree ("window_start");--> statement-breakpoint
-- Operational table (no tenant data, no organization_id, keys are SHA-256): the runtime role counts and expires rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO voice_app;
