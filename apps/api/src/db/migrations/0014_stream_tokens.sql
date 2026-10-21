CREATE TABLE "stream_token_uses" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "stream_token_uses_expires_idx" ON "stream_token_uses" USING btree ("expires_at");--> statement-breakpoint
-- Operational table (no tenant data, no organization_id): the runtime role counts and expires rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON stream_token_uses TO voice_app;
