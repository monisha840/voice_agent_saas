-- Emergency rollback of migrations 0019 (billing foundation) and 0020 (seat caps). Tested only against an isolated
-- scratch database (modules/billing/billing-migration.test.ts). It DESTROYS billing data (subscriptions, the usage
-- ledger, payment-event records): export them first. It touches no pre-billing table, policy, role or grant.
--
-- After running it, remove the two newest rows from drizzle.__drizzle_migrations (tags 0019_billing_foundation and
-- 0020_entitlement_seat_caps) before running db:migrate again.
--
-- Rolling back WITHOUT the data loss: set BILLING_ENFORCEMENT=off (call admission) and drop the three triggers
-- below (seat caps); the tables can stay.

DROP TRIGGER IF EXISTS billing_invitation_cap_trg ON invitations;
DROP TRIGGER IF EXISTS billing_member_cap_trg ON memberships;
DROP TRIGGER IF EXISTS billing_agent_cap_trg ON agents;
DROP FUNCTION IF EXISTS billing_enforce_member_cap();
DROP FUNCTION IF EXISTS billing_enforce_agent_cap();
DROP FUNCTION IF EXISTS billing_cap_for(uuid, text);

DROP TRIGGER IF EXISTS usage_ledger_guard_trg ON usage_ledger;
-- The append-only trigger blocks row deletes; dropping the tables removes the data deliberately.
DROP TABLE IF EXISTS billing_events;
DROP TABLE IF EXISTS usage_ledger;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS plans;
DROP FUNCTION IF EXISTS usage_ledger_guard();
DROP TYPE IF EXISTS usage_ledger_state;
DROP TYPE IF EXISTS subscription_status;
