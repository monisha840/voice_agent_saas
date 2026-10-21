-- 0025 remove the four plan entitlements the product advertised but never enforced.
--
-- Decision D3, resolved 2026-10-21: stop advertising them, do not build them. Selling a data-retention guarantee
-- nothing enforces is legal exposure.
--
--   retentionDays : retention is ONE global operator setting (SECURITY_EVENT_RETENTION_*, docs/security/
--                   audit-retention.md); no per-plan, per-organization purge job exists.
--   analytics     : no tiered analytics exist.
--   apiAccess     : no API-key / public API feature exists.
--   webhooks      : no outbound webhook delivery exists.
--
-- Data only: no schema, policy, role, grant or trigger change. The ENFORCED entitlements are untouched --
-- maxConcurrentCalls, maxAgents and maxTeamMembers stay in the JSON (the seat caps are enforced by the
-- migration-0020 triggers, which read exactly these keys), and included_minutes is a column this does not name.
--
-- Migration 0019 is already applied everywhere and must not be edited (the repo documents a deliberate stored-hash
-- mismatch on it), so it keeps seeding the dead keys into a database created from scratch; this migration runs after
-- it and strips them again. The pair is therefore correct for a fresh database and for an existing one alike.
--
-- Idempotent: the predicate matches only rows that still carry one of the keys, and `jsonb - text[]` on absent keys
-- is a no-op anyway, so a re-run changes nothing (0 rows).
--
-- subscriptions.limit_overrides is deliberately NOT rewritten. The table has FORCE ROW LEVEL SECURITY (0019), so an
-- UPDATE here -- even as the table owner -- would match no row without a tenant context, and a stale dead key left
-- in a negotiated override is ignored on read: entitlementsSchema / limitOverridesSchema strip unknown keys
-- (apps/api/src/modules/billing/plan-types.ts), so it can neither grant nor refuse anything.
--
-- Rollback (should the keys ever be re-advertised, i.e. after they are built):
--   UPDATE plans SET entitlements = entitlements || '{"retentionDays":30,"analytics":"basic"}'::jsonb WHERE key = ...
-- Nothing in the code or the database reads the removed keys, so no rollback is needed for this migration itself.
UPDATE plans
SET entitlements = entitlements - array['retentionDays', 'analytics', 'apiAccess', 'webhooks']::text[],
    updated_at = now()
WHERE entitlements ?| array['retentionDays', 'analytics', 'apiAccess', 'webhooks'];
