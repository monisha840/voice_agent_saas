-- Row-level security: database-enforced tenant isolation.
--
-- ADDITIVE and re-runnable. It creates two NOLOGIN roles, enables + forces RLS on every tenant-owned table,
-- and adds a handful of narrowly-scoped SECURITY DEFINER lookups for the flows that must find a tenant from a
-- credential before any tenant is known (provider webhooks, inbound calls, invitations, the stale-call reaper).
--
--   voice_app       the RUNTIME role. Not an owner, no BYPASSRLS, no superuser. The deployment gives it LOGIN and a
--                   password out of band (ALTER ROLE voice_app LOGIN PASSWORD '...'), never this migration.
--   voice_resolver  owns the lookup functions only; SELECT on a few columns of three tables. NOLOGIN.
--
-- The runtime sets `app.organization_id` / `app.user_id` with set_config(..., is_local => true) inside every
-- statement's transaction. An unset or empty setting yields NULL, so every policy comparison is false: it fails closed.
--
-- ROLLBACK (manual, documented in docs/security/rls-rollout.md): ALTER TABLE ... NO FORCE / DISABLE ROW LEVEL SECURITY
-- per table (policies can stay), or drop the policies; the functions and roles can stay unused.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voice_app') THEN
    CREATE ROLE voice_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voice_resolver') THEN
    CREATE ROLE voice_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
--> statement-breakpoint

-- A non-superuser migration role must be able to hand function ownership to voice_resolver.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT voice_resolver TO %I', current_user);
  END IF;
END
$$;
--> statement-breakpoint

-- Tenant context readers. Malformed values raise (fail closed); unset/empty is NULL (matches nothing).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant-owned tables: every row carries organization_id; one policy for reads AND writes. USING confines the rows
-- visible to / updatable by the statement, WITH CHECK confines the rows it may write (so ownership cannot be moved).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'project_knowledge', 'leads', 'calls', 'conversations', 'site_visits', 'follow_ups',
    'organization_modules', 'project_members', 'invitations', 'agent_configs', 'agents',
    'agent_knowledge_bindings', 'audit_logs', 'usage_events', 'agent_phone_numbers'
  ]
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
$$;
--> statement-breakpoint

-- memberships: a user may SEE their own memberships in any organization (to list/choose organizations), but may
-- only WRITE memberships of the active organization. Split policies, so "own row" never grants write access.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS memberships_select ON memberships;
--> statement-breakpoint
DROP POLICY IF EXISTS memberships_insert ON memberships;
--> statement-breakpoint
DROP POLICY IF EXISTS memberships_update ON memberships;
--> statement-breakpoint
DROP POLICY IF EXISTS memberships_delete ON memberships;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (organization_id = (SELECT app_current_org()) OR user_id = (SELECT app_current_user()));
--> statement-breakpoint
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org()));
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (organization_id = (SELECT app_current_org())) WITH CHECK (organization_id = (SELECT app_current_org()));
--> statement-breakpoint
CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (organization_id = (SELECT app_current_org()));
--> statement-breakpoint

-- organizations: the tenant root. Visible when it is the active organization or the user is a member (the
-- membership subquery is itself RLS-filtered to the user's own rows). Only the active organization is updatable.
-- No INSERT/DELETE policy: organizations are provisioned by the administrative role (scripts/create-org.ts), never
-- by the runtime role.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS organizations_select ON organizations;
--> statement-breakpoint
DROP POLICY IF EXISTS organizations_update ON organizations;
--> statement-breakpoint
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (
    id = (SELECT app_current_org())
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = (SELECT app_current_user()))
  );
--> statement-breakpoint
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = (SELECT app_current_org())) WITH CHECK (id = (SELECT app_current_org()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Narrow cross-tenant lookups. Each returns ONLY an organization id (or ids), is owned by voice_resolver (which can
-- read just the columns it needs, through its own policy), runs with a fixed search_path, and is executable by
-- voice_app only. The caller then performs the real work inside a normal tenant-scoped statement.
-- ---------------------------------------------------------------------------------------------------------------
GRANT SELECT (id, organization_id, provider_call_id, status, created_at, started_at) ON calls TO voice_resolver;
--> statement-breakpoint
GRANT SELECT (organization_id, phone_number) ON agent_phone_numbers TO voice_resolver;
--> statement-breakpoint
GRANT SELECT (organization_id, token_hash, accepted_at, revoked_at, expires_at) ON invitations TO voice_resolver;
--> statement-breakpoint
GRANT SELECT (id, organization_id, status) ON projects TO voice_resolver;
--> statement-breakpoint
DROP POLICY IF EXISTS resolver_lookup ON projects;
--> statement-breakpoint
CREATE POLICY resolver_lookup ON projects FOR SELECT TO voice_resolver USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS resolver_lookup ON calls;
--> statement-breakpoint
DROP POLICY IF EXISTS resolver_lookup ON agent_phone_numbers;
--> statement-breakpoint
DROP POLICY IF EXISTS resolver_lookup ON invitations;
--> statement-breakpoint
CREATE POLICY resolver_lookup ON calls FOR SELECT TO voice_resolver USING (true);
--> statement-breakpoint
CREATE POLICY resolver_lookup ON agent_phone_numbers FOR SELECT TO voice_resolver USING (true);
--> statement-breakpoint
CREATE POLICY resolver_lookup ON invitations FOR SELECT TO voice_resolver USING (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_resolve_call_org(p_call_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT organization_id FROM calls WHERE id = p_call_id $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_resolve_call_org_by_provider_id(p_provider_call_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT organization_id FROM calls WHERE provider_call_id = p_provider_call_id $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_resolve_project_org(p_project_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT organization_id FROM projects WHERE id = p_project_id AND status = 'active' $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_resolve_phone_number_org(p_phone_number text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT organization_id FROM agent_phone_numbers WHERE phone_number = p_phone_number $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_resolve_invitation_org(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT organization_id FROM invitations
    WHERE token_hash = p_token_hash AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_list_stale_calls(p_pending_before timestamptz, p_in_progress_before timestamptz)
  RETURNS TABLE (id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT c.id, c.organization_id FROM calls c
    WHERE (c.status IN ('initiating', 'ringing') AND c.created_at < p_pending_before)
       OR (c.status = 'in_progress' AND coalesce(c.started_at, c.created_at) < p_in_progress_before)
  $$;
--> statement-breakpoint

ALTER FUNCTION app_resolve_call_org(uuid) OWNER TO voice_resolver;
--> statement-breakpoint
ALTER FUNCTION app_resolve_call_org_by_provider_id(text) OWNER TO voice_resolver;
--> statement-breakpoint
ALTER FUNCTION app_resolve_project_org(uuid) OWNER TO voice_resolver;
--> statement-breakpoint
ALTER FUNCTION app_resolve_phone_number_org(text) OWNER TO voice_resolver;
--> statement-breakpoint
ALTER FUNCTION app_resolve_invitation_org(text) OWNER TO voice_resolver;
--> statement-breakpoint
ALTER FUNCTION app_list_stale_calls(timestamptz, timestamptz) OWNER TO voice_resolver;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_resolve_call_org(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_call_org_by_provider_id(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_project_org(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_phone_number_org(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_invitation_org(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stale_calls(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_org() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_user() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_call_org(uuid) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_call_org_by_provider_id(text) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_project_org(uuid) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_phone_number_org(text) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_invitation_org(text) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stale_calls(timestamptz, timestamptz) TO voice_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org() TO voice_app, voice_resolver;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user() TO voice_app, voice_resolver;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Runtime privileges: data access only. No DDL, no ownership, no TRUNCATE; the append-only ledgers cannot be
-- rewritten by the application.
-- ---------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO voice_app, voice_resolver;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM voice_app, voice_resolver;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voice_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO voice_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_logs FROM voice_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON usage_events FROM voice_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO voice_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO voice_app;
