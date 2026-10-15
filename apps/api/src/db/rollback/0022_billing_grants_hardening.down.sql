-- Rollback of 0022 (billing grants hardening): restores the exact pre-0022 privileges, i.e. table-level UPDATE for the
-- runtime role on billing_events and usage_ledger and no column-level grant on usage_ledger.state. This LOOSENS
-- privileges; the usage_ledger_guard trigger still makes every ledger column except `state` immutable for all roles.
-- Tested on a scratch database only (modules/billing/billing-migration.test.ts). Then remove the 0022 row from
-- drizzle.__drizzle_migrations if the migration is to be re-applied.
REVOKE UPDATE ("state") ON usage_ledger FROM voice_app;
GRANT UPDATE ON billing_events TO voice_app;
GRANT UPDATE ON usage_ledger TO voice_app;
