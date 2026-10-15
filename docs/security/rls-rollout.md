# Tenant isolation, authentication and security: rollout guide

Applies to migrations `0012_row_level_security` and `0013_auth_security` and the matching application release.
No secret values appear in this document; every secret is supplied by the deployment.

## 1. What changed, in one paragraph

Tenant isolation is now enforced **by PostgreSQL**, not only by application filters. The API connects as a
restricted role (`voice_app`) that owns nothing, cannot bypass row-level security (RLS), and cannot change the
schema. Every statement runs with a transaction-local tenant (`app.organization_id` / `app.user_id`) set from a
verified source (the authenticated membership, or the organization that owns a call/invitation/number). With no
tenant set, every tenant table reads as empty and rejects writes.

## 2. Database identities

| Role | Created by | Login | Purpose | Notes |
|---|---|---|---|---|
| owner / migration role (existing) | you | yes | run migrations, provisioning scripts | needs `CREATEROLE` the first time (or create the two roles below yourself); never used by the running API |
| `voice_app` | migration 0012 (NOLOGIN) | **set by you** | the running API | not owner, no BYPASSRLS, no SUPERUSER; DML only; cannot UPDATE/DELETE `audit_logs`, `usage_events`, `security_events` |
| `voice_resolver` | migration 0012 (NOLOGIN) | never | owns the SECURITY DEFINER lookup functions | column-level SELECT on 4 tables only; no write privilege anywhere |

Give `voice_app` a password out of band:

```
DATABASE_URL=<owner url> DATABASE_ADMIN_URL=<owner url> VOICE_APP_PASSWORD='<24+ random chars>' \
  pnpm --filter @voice-agent/api db:provision-runtime-role
```

On a managed Postgres where the migration role is not a superuser, run `GRANT voice_resolver TO <migration role>`
once (the migration does this automatically when it can) so function ownership can be assigned.

## 3. Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `DATABASE_URL` | API runtime | **the `voice_app` URL** |
| `DATABASE_MIGRATION_URL` | migration job | the owner URL (direct, not pooled) |
| `DATABASE_ADMIN_URL` | operator scripts / test only | owner URL for `db:seed`, `org:create`, `user:admin`. **Must not be set on the API runtime in production** (startup validation refuses) |
| `MFA_ENCRYPTION_KEY` | API runtime | base64 of 32 random bytes; encrypts TOTP seeds (AES-256-GCM). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Losing it makes enrolled seeds unreadable (users would need an operator MFA reset); rotate by re-enrolment |
| `MFA_ENFORCEMENT` | API runtime | `off` / `warn` (default) / `enforce` |
| `MFA_ISSUER`, `REAUTH_WINDOW_MS`, `MFA_PENDING_TTL_MS` | optional | authenticator label, how recent a password proof must be (10 min), how long a half-finished login lives (10 min) |
| `LOGIN_PAIR_THRESHOLD`, `LOGIN_IP_THRESHOLD`, `LOGIN_ACCOUNT_THRESHOLD`, `LOGIN_BASE_LOCK_MS`, `LOGIN_MAX_LOCK_MS`, `LOGIN_FAILURE_WINDOW_MS` | optional | throttle tuning (defaults 5 / 30 / 20 / 30 s / 15 min / 15 min) |
| `PASSWORD_MIN_LENGTH`, `PWNED_PASSWORDS` | optional | minimum length (10); `off` / `fail-open` / `fail-closed` breached-password screening (HIBP range API, k-anonymity) |

## 4. Migration order (zero-downtime, additive)

1. Back up the database.
2. Run migrations with the **owner** URL: `pnpm --filter @voice-agent/api db:migrate`
   (0012 is idempotent and additive; 0013 adds columns/tables only). The previous API release keeps working during
   this step because it still connects as the owner, which `FORCE ROW LEVEL SECURITY` makes subject to the policies
   **unless the owner is a superuser or has BYPASSRLS** — see the warning below.
3. Provision the `voice_app` password (section 2).
4. Deploy the new API release with `DATABASE_URL` = `voice_app`. At boot it refuses to start in production if the
   role is a superuser / BYPASSRLS / table owner, or if RLS is not enabled.
5. Smoke test (section 6).

> **Warning (step 2):** if your *old* API connects as a role that is not a superuser/BYPASSRLS, RLS applies to it
> the moment 0012 is applied and it will see no rows (it never sets the tenant). Deploy the new API release in the
> same window, or run step 2 only when the old API already connects as a superuser/BYPASSRLS owner (the dev
> docker database does).

## 5. Rollback

* **Application**: redeploy the previous release. It will not work against `voice_app` (it never sets a tenant);
  point it back at the owner URL.
* **RLS (emergency, incident-recorded)**: run `apps/api/src/db/rollback/0012_row_level_security.down.sql` as the
  owner. This *removes database enforcement*; isolation falls back to application filters. It is tested
  (`db/migration-upgrade.test.ts`) and never run automatically. Re-enable with `apps/api/src/db/rollback/0012_row_level_security.reenable.sql` (NOT by re-running 0012: that would re-widen grants that 0013/0015/0019 narrowed; see docs/security/migration-reconciliation.md).
* **0013** is additive (new nullable columns, new tables); it needs no rollback. Dropping its objects is
  destructive (it discards MFA enrolments and security events) and is intentionally not scripted.

## 6. Smoke test after deploy

1. `GET /ready` is 200.
2. Sign in as a tenant user; the dashboard lists that tenant's data only.
3. As the runtime role, `select count(*) from leads;` returns 0 (no tenant set).
4. Place a test call (web call or simulator): it completes and is finalized (this exercises the system flows).
5. `pnpm --filter @voice-agent/api test` (against a disposable database) is green, including
   `db/rls.test.ts` and `security/guardrails.test.ts`.

## 7. Operating notes

* Pool sizing: each statement is a short transaction (`BEGIN; set_config; <stmt>; COMMIT`), so connections are
  held only per statement. Transaction-mode poolers (PgBouncer/Supabase :6543) are supported
  (`DATABASE_PREPARE=false`); nothing is stored on a pooled connection.
* New tenant tables: add `organization_id uuid NOT NULL`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, a
  `tenant_isolation` policy, and list the table in `security/guardrails.test.ts`. The guardrail test fails the
  build otherwise.
* New cross-tenant lookups require a SECURITY DEFINER function owned by `voice_resolver` and a documented entry in
  `docs/security/system-access.md`; do not grant the runtime role BYPASSRLS.
* Housekeeping: expired sessions and stale throttle counters are removed every 10 minutes by the API.
