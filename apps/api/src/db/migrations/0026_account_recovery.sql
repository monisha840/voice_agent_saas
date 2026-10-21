-- 0026 account recovery: customer-facing password reset ("forgot password") and e-mail verification.
--
-- ADDITIVE only. One new enum type, one new table and one new nullable column on users. No existing table, policy,
-- role, grant, function or trigger is changed, so it is safe to apply before the matching API release ships.
--
-- WHY account_tokens HAS NO ROW-LEVEL SECURITY
--   It is identity data, in exactly the same class as sessions, mfa_recovery_codes and auth_throttle (see the
--   classification in security/guardrails.test.ts): it carries NO organization_id and holds no tenant content --
--   only a user id, the address the token was issued for, a SHA-256 hash, timestamps and the requesting IP.
--
--   A password-reset lookup happens with no session AND no tenant context. Every policy in this database compares
--   against app_current_org() / app_current_user() (migration 0012), both of which are NULL in that situation, so
--   ANY policy here would make the row invisible and the flow dead on arrival. The only two ways around that would
--   be (a) USING (true), which the guardrail test forbids outright, or (b) a SECURITY DEFINER resolver owned by
--   voice_resolver, the shape used by app_resolve_invitation_org. (b) exists because `invitations` IS tenant data
--   (it carries organization_id) and the accept flow needs the owning organization before it can do real work.
--   Neither applies here: a password reset is an account-level fact about `users`, there is no organization to
--   resolve, and `users` / `sessions` themselves are deliberately outside RLS for precisely this reason -- the
--   authentication layer runs before a tenant is known.
--
--   The security property is therefore carried by the CREDENTIAL, not by a row policy, the same way sessions.
--   token_hash is: only sha256(token) is stored (the token is e-mailed once and never persisted), `used_at` makes
--   a token single-use so it cannot be replayed, `expires_at` bounds its life, and the table is only ever
--   addressed by token_hash or user_id -- never enumerated. A full read of it yields nothing replayable.
--
-- Rollback (destructive; discards outstanding reset/verification links and the verified flag):
--   DROP TABLE account_tokens; DROP TYPE account_token_purpose; ALTER TABLE users DROP COLUMN email_verified_at;
-- Outstanding links simply stop working; users request new ones. Nothing else reads these objects.
CREATE TYPE "public"."account_token_purpose" AS ENUM('password_reset', 'email_verification');--> statement-breakpoint
CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "account_token_purpose" NOT NULL,
	"email" varchar(320) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_token_hash_unique" ON "account_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_tokens_user_purpose_idx" ON "account_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "account_tokens_expires_idx" ON "account_tokens" USING btree ("expires_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written part. Privileges only: no policy, no role, no function.
--
-- 0012 set ALTER DEFAULT PRIVILEGES for voice_app, so a table created by this (owner) migration already carries
-- the grant; it is restated explicitly here for the same reason 0018 and 0021 do -- the file should state the
-- runtime role's privilege on its own table rather than depend on a default set three migrations earlier.
--
-- The runtime role needs all four verbs: INSERT to mint a token, SELECT to look one up by hash, UPDATE to mark it
-- used (and to supersede older unused ones), DELETE for the janitor that removes expired rows. USAGE on the enum
-- type is needed to write the `purpose` column.
-- ---------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON account_tokens TO voice_app;
--> statement-breakpoint
GRANT USAGE ON TYPE "public"."account_token_purpose" TO voice_app;
