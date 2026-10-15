# Security event retention

Scope: the `security_events` table (authentication / session / MFA / access-denial / privileged-action trail).
The business `audit_logs` table and `usage_events` are out of scope and are never purged by this mechanism.

## Status: OFF by default

Nothing is deleted unless `SECURITY_EVENT_RETENTION_ENABLED=true`. The periods below are conservative engineering
defaults, NOT an approved retention policy. Do not enable in production before business/legal sign-off (see below).

## Policy

| Category (env suffix) | Event types | Default | Env var |
|---|---|---|---|
| `AUTH_SESSION` | `auth.login.*`, `auth.logout`, `auth.password.*`, `auth.reauthenticat*`, `auth.account.*`, `session.*` | 400 days | `SECURITY_EVENT_RETENTION_DAYS_AUTH_SESSION` |
| `MFA_CONFIG` | `auth.mfa.*`, `membership.*` | 730 days | `SECURITY_EVENT_RETENTION_DAYS_MFA_CONFIG` |
| `ACCESS_DENIED` | `access.tenant_denied`, `access.role_denied`, `access.stream_denied` | 400 days | `SECURITY_EVENT_RETENTION_DAYS_ACCESS_DENIED` |
| `PRIVILEGED_ACTION` | `system.privileged_action` (includes the purge's own record) | 730 days | `SECURITY_EVENT_RETENTION_DAYS_PRIVILEGED_ACTION` |
| `OTHER` | anything not matched above | 400 days | `SECURITY_EVENT_RETENTION_DAYS_OTHER` |

Other settings:

| Env var | Default | Meaning |
|---|---|---|
| `SECURITY_EVENT_RETENTION_ENABLED` | `false` | Master switch. |
| `SECURITY_EVENT_RETENTION_ARCHIVE` | `false` | Copy purged rows into `security_events_archive` (same statement, atomic) instead of dropping them. |
| `SECURITY_EVENT_RETENTION_BATCH_SIZE` | `1000` | Rows per database call (1..10000). |
| `SECURITY_EVENT_RETENTION_MAX_BATCHES` | `20` | Batches per janitor run (so at most batch x max per 10 minute tick). |

Rules: a period is a whole number of days, minimum 1. A row is removed when `created_at < now - days`; a row exactly
at the cutoff is kept. Category assignment lives in SQL (`app_security_event_category`, migration 0015); a new event
type is `OTHER` until classified there. A category with no cutoff is never purged.

## How it works

- `voice_app` (runtime role) has no DELETE/UPDATE/TRUNCATE on `security_events` and still does not.
- Migration `0015_security_event_retention.sql` adds the NOLOGIN role `voice_retention` (SELECT, DELETE and
  `UPDATE (id)` on `security_events` for row locking, INSERT on the archive; nothing else) and the SECURITY DEFINER
  function `app_purge_security_events(cutoffs jsonb, batch int, archive boolean)` with a fixed `search_path`,
  EXECUTE granted to `voice_app` only. It deletes at most `batch` rows using `FOR UPDATE SKIP LOCKED`, so concurrent
  runs (several API instances) never double count or deadlock, and returns per-category counts.
- The security janitor (`runtime/security-janitor.ts`, every 10 minutes, never in a request path) calls it in
  bounded batches, logs counts only, and records one `system.privileged_action` event
  (`action: security_events.retention_purge`, totals and per-category counts, no payloads) when rows were removed.
  A failure is logged and retried on the next tick; it does not stop the other janitor tasks.
- `security_events_archive`: same columns plus `archived_at`, no foreign keys, no privilege for `voice_app`
  (cannot read or write it). Read it with the administrative role only.

## Needs legal / business approval before enabling

1. The retention period of each category (contract terms, customer DPAs, sector rules, incident-investigation need).
   Some customers may require longer periods or per-tenant overrides (not implemented).
2. Whether purged rows must be archived (`ARCHIVE=true`) and for how long the archive itself may be kept; the archive
   has no purge job today, so it grows until a policy and a job exist. It holds IP addresses and user agents (personal
   data): its access, encryption and erasure obligations need an owner.
3. Whether purged data must be erasable on a data-subject request (the archive is not tenant-addressable by the app).
4. Legal holds: there is no per-tenant hold mechanism. If an investigation or litigation is open, keep the switch off.

## Backups

Deleting rows does not remove them from existing backups or snapshots; they age out with the backup retention. A
restore of a backup older than the purge brings purged rows back, and the next janitor run removes them again
(idempotent). Keep backup retention at or above the longest active event retention only if the data must remain
recoverable; set it deliberately, because the effective retention is the longer of the two.

## Operational procedure

1. Obtain approval of the periods; set the `SECURITY_EVENT_RETENTION_DAYS_*` values accordingly.
2. Apply migration 0015 (as the migration/owner role; the role must be able to `CREATE ROLE`/`GRANT voice_retention`
   like migration 0012).
3. Dry run: count what would go (administrative role):
   ```sql
   select app_security_event_category(event_type) as category, count(*)
   from security_events
   where created_at < now() - interval '400 days'   -- adjust per category
   group by 1;
   ```
4. Enable with `SECURITY_EVENT_RETENTION_ENABLED=true` (and `ARCHIVE=true` if required). Start with a small
   `BATCH_SIZE`; watch the `security-janitor: security events purged` log lines and the
   `system.privileged_action` events.
5. Disable by setting `SECURITY_EVENT_RETENTION_ENABLED=false` and restarting; already purged rows stay purged
   (or in the archive).

## Run once manually

From `apps/api`, with the runtime `DATABASE_URL` and the settings in the environment:

```
SECURITY_EVENT_RETENTION_ENABLED=true SECURITY_EVENT_RETENTION_MAX_BATCHES=5 \
  npx tsx -e "import('./src/runtime/security-janitor.ts').then(async m => { console.log(await m.runSecurityEventRetentionOnce()); process.exit(0); })"
```

It prints `{ ran, purged, total, batches }` and is safe to run while the API is up.

## Rollback

`DROP FUNCTION app_purge_security_events(jsonb, int, boolean);` stops all purging at the database level. The role,
archive table and data can stay.
