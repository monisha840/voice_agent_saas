-- Audit retention for security_events. ADDITIVE and re-runnable.
--
-- The runtime role (voice_app) keeps NO DELETE/UPDATE on security_events (migration 0013). Retention is the only
-- way rows leave, through ONE SECURITY DEFINER function owned by a dedicated NOLOGIN role (voice_retention) that
-- can touch security_events and nothing else. The function takes absolute per-category cutoffs from the caller;
-- a category without a cutoff is never purged (fail safe). Purging is OFF unless the worker is enabled by config.
--
-- Rollback: DROP FUNCTION app_purge_security_events(jsonb, int, boolean); the table, role and data can stay.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voice_retention') THEN
    CREATE ROLE voice_retention NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
--> statement-breakpoint

-- A non-superuser migration role must be able to hand function ownership to voice_retention.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT voice_retention TO %I', current_user);
  END IF;
END
$$;
--> statement-breakpoint

-- Archive of purged rows: same columns plus archived_at. No foreign keys (rows must survive anything). The runtime
-- role has no privilege at all on it; read it with the administrative role only.
CREATE TABLE IF NOT EXISTS "security_events_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"event_type" varchar(80) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(256),
	"request_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_archive_org_created_idx" ON "security_events_archive" USING btree ("organization_id","created_at");
--> statement-breakpoint
ALTER TABLE security_events_archive ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_events_archive FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON security_events_archive FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON security_events_archive FROM voice_app;
--> statement-breakpoint
GRANT INSERT ON security_events_archive TO voice_retention;
--> statement-breakpoint
DROP POLICY IF EXISTS retention_archive_insert ON security_events_archive;
--> statement-breakpoint
CREATE POLICY retention_archive_insert ON security_events_archive FOR INSERT TO voice_retention WITH CHECK (true);
--> statement-breakpoint

-- voice_retention on security_events: select + delete, and UPDATE on the id column only because FOR UPDATE SKIP
-- LOCKED requires an UPDATE privilege (no UPDATE statement is ever issued; the function body is fixed).
GRANT USAGE ON SCHEMA public TO voice_retention;
--> statement-breakpoint
GRANT SELECT, DELETE ON security_events TO voice_retention;
--> statement-breakpoint
GRANT UPDATE (id) ON security_events TO voice_retention;
--> statement-breakpoint
DROP POLICY IF EXISTS retention_select ON security_events;
--> statement-breakpoint
DROP POLICY IF EXISTS retention_lock ON security_events;
--> statement-breakpoint
DROP POLICY IF EXISTS retention_delete ON security_events;
--> statement-breakpoint
CREATE POLICY retention_select ON security_events FOR SELECT TO voice_retention USING (true);
--> statement-breakpoint
CREATE POLICY retention_lock ON security_events FOR UPDATE TO voice_retention USING (true) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY retention_delete ON security_events FOR DELETE TO voice_retention USING (true);
--> statement-breakpoint

-- Retention category of an event type. Keep in sync with config/env.ts (securityRetention) and the docs.
CREATE OR REPLACE FUNCTION app_security_event_category(p_event_type text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_event_type = 'system.privileged_action' THEN 'privileged_action'
    WHEN p_event_type LIKE 'access.%' THEN 'access_denied'
    WHEN p_event_type LIKE 'auth.mfa.%' OR p_event_type LIKE 'membership.%' THEN 'mfa_config'
    WHEN p_event_type LIKE 'auth.%' OR p_event_type LIKE 'session.%' THEN 'auth_session'
    ELSE 'other'
  END
$$;
--> statement-breakpoint

-- Deletes at most p_batch rows older than their category's cutoff (created_at < cutoff: a row exactly AT the cutoff
-- is kept). Concurrent callers skip rows another caller has locked, so they never double count or deadlock.
-- When p_archive is true the rows are copied to security_events_archive in the same statement (atomic).
CREATE OR REPLACE FUNCTION app_purge_security_events(p_category_cutoffs jsonb, p_batch int, p_archive boolean DEFAULT false)
RETURNS TABLE (category text, purged int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'p_batch must be between 1 and 10000';
  END IF;
  IF p_category_cutoffs IS NULL OR jsonb_typeof(p_category_cutoffs) <> 'object' THEN
    RAISE EXCEPTION 'p_category_cutoffs must be a JSON object';
  END IF;

  IF p_archive THEN
    RETURN QUERY
    WITH cand AS (
      SELECT e.id FROM public.security_events e
      WHERE e.created_at < (p_category_cutoffs ->> public.app_security_event_category(e.event_type))::timestamptz
      ORDER BY e.created_at
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), del AS (
      DELETE FROM public.security_events s USING cand WHERE s.id = cand.id RETURNING s.*
    ), arch AS (
      INSERT INTO public.security_events_archive
        (id, organization_id, actor_user_id, event_type, outcome, ip_address, user_agent, request_id, metadata, created_at)
      SELECT d.id, d.organization_id, d.actor_user_id, d.event_type, d.outcome, d.ip_address, d.user_agent, d.request_id, d.metadata, d.created_at
      FROM del d
      RETURNING 1
    )
    SELECT public.app_security_event_category(d.event_type), count(*)::int
    FROM del d WHERE (SELECT count(*) FROM arch) >= 0
    GROUP BY 1;
  ELSE
    RETURN QUERY
    WITH cand AS (
      SELECT e.id FROM public.security_events e
      WHERE e.created_at < (p_category_cutoffs ->> public.app_security_event_category(e.event_type))::timestamptz
      ORDER BY e.created_at
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), del AS (
      DELETE FROM public.security_events s USING cand WHERE s.id = cand.id RETURNING s.event_type
    )
    SELECT public.app_security_event_category(d.event_type), count(*)::int FROM del d GROUP BY 1;
  END IF;
END
$$;
--> statement-breakpoint
ALTER FUNCTION app_purge_security_events(jsonb, int, boolean) OWNER TO voice_retention;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_security_events(jsonb, int, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_security_events(jsonb, int, boolean) TO voice_app;
