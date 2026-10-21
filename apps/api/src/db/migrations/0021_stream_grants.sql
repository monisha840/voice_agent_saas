CREATE TABLE "stream_grants" (
	"grant_hash" varchar(64) PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"provider_call_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "stream_grants_expires_idx" ON "stream_grants" USING btree ("expires_at");
--> statement-breakpoint
-- Operational table: SHA-256 of an opaque per-call grant + call id + provider call id + counters. No tenant content
-- and no organization_id (the organization is read from the call record), so no RLS. The runtime role mints,
-- consumes and (via the janitor) deletes rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON stream_grants TO voice_app;
