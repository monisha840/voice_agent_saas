-- RE-ENABLE row-level security after the emergency rollback (0012_row_level_security.down.sql). Run as the owner role.
--
-- Prefer this over re-running 0012_row_level_security.sql: that migration also issues a blanket GRANT to voice_app
-- which would WIDEN privileges that migrations 0013/0015/0019 deliberately narrowed (e.g. DELETE/UPDATE on
-- security_events, DELETE on usage_ledger/billing_events, write on the plans catalog). The rollback only toggled
-- ENABLE/FORCE ROW LEVEL SECURITY (policies and grants are untouched), so this restores exactly that and nothing else.
-- Verified in a scratch database by apps/api/src/db/migration-upgrade.test.ts (catalog equal to the head catalog).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'project_knowledge', 'leads', 'calls', 'conversations', 'site_visits', 'follow_ups',
    'organization_modules', 'project_members', 'invitations', 'agent_configs', 'agents',
    'agent_knowledge_bindings', 'audit_logs', 'usage_events', 'agent_phone_numbers',
    'memberships', 'organizations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
