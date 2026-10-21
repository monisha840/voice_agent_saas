-- Rollback of 0024 (number management). Drops the per-number routing switch, the refused-attempt record, the provider
-- check result and calls.line_number. Numbers and their agent assignment are kept (they predate 0024).
-- WARNING: paused numbers become ACTIVE again (the pre-0024 code has no pause), so inbound calls on them will be
-- answered. Check `SELECT phone_number FROM agent_phone_numbers WHERE NOT routing_enabled` first and remove those
-- numbers (or accept that) before running this. The record of which number each inbound call came in on is lost.
-- Run as the owner, in one transaction, after deploying code that does not use these columns. Never run automatically;
-- tested on a scratch database only (db/migration-0024.test.ts). To re-apply 0024 afterwards, also delete its row from
-- drizzle.__drizzle_migrations (created_at = the 0024 journal entry's "when") and run the migrator.
BEGIN;
DROP INDEX IF EXISTS calls_org_line_created_idx;
ALTER TABLE calls DROP COLUMN IF EXISTS line_number;
ALTER TABLE agent_phone_numbers
  DROP COLUMN IF EXISTS routing_enabled,
  DROP COLUMN IF EXISTS last_inbound_at,
  DROP COLUMN IF EXISTS refused_count,
  DROP COLUMN IF EXISTS last_refused_at,
  DROP COLUMN IF EXISTS last_refused_reason,
  DROP COLUMN IF EXISTS last_refused_call_id,
  DROP COLUMN IF EXISTS provider_status,
  DROP COLUMN IF EXISTS provider_detail,
  DROP COLUMN IF EXISTS provider_checked_at,
  DROP COLUMN IF EXISTS updated_at;
COMMIT;
