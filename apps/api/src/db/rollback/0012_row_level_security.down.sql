-- EMERGENCY ROLLBACK of migration 0012 (row-level security). NOT run automatically, NOT part of the migration chain.
--
-- Effect: tenants are no longer isolated by the database; isolation falls back to the application-level
-- organization filters only. Run it only with an incident record, as the migration/owner role, and re-apply
-- 0012_row_level_security.sql (it is idempotent) as soon as the cause is fixed.
--
-- Roles are left in place (they are harmless without grants being used). Data is untouched.

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
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
