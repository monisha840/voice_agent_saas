-- Billing grants hardening (security workstream 1, item 2). ADDITIVE and idempotent: only privileges are narrowed;
-- no table, policy, role, trigger or function is created or altered, and no data is touched.
--
-- Review result (see docs/billing/security-review-ws1.md):
--   * billing_events: the application only ever INSERTs (billingEventsRepository.recordAndApply / insertIfNew). No
--     code path updates a row. The table-level UPDATE that default privileges gave voice_app is unnecessary.
--   * usage_ledger: the ONLY update is `SET state = 'superseded'` (usageLedgerRepository.supersede). Every other column
--     is immutable (trigger usage_ledger_guard also enforces this for ALL roles). UPDATE is narrowed to the state column.
-- DELETE was already revoked by 0019. The ledger and event log therefore stay append-only for the runtime role.
REVOKE UPDATE ON "billing_events" FROM "voice_app";--> statement-breakpoint
REVOKE UPDATE ON "usage_ledger" FROM "voice_app";--> statement-breakpoint
GRANT UPDATE ("state") ON "usage_ledger" TO "voice_app";
