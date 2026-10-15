CREATE TABLE "stream_claims" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"instance_id" varchar(64) NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "stream_claims_heartbeat_idx" ON "stream_claims" USING btree ("heartbeat_at");--> statement-breakpoint
-- Operational table (call id + instance id + timestamps; no tenant data, no organization_id): the runtime role
-- claims, heartbeats and releases rows, and the janitor deletes stale ones.
GRANT SELECT, INSERT, UPDATE, DELETE ON stream_claims TO voice_app;
