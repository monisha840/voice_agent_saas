# Migration and schema reconciliation (2026-10-14)

> **Update (later on 2026-10-14):** sections 1, 2 and 4 below describe dev as it was when first reviewed (19 rows,
> early 0019 draft). Since then, after a fresh backup (`db-backups/voice_agent_mvp_pre-0019-delta_20261014_192045.dump`),
> the current 0019 hardening delta was hand-applied (recovery option 1b, WITHOUT rewriting the stored 0019 hash) and
> 0020/0021 were applied through the guarded migrator. Verified read-only by the RC migration review
> (`docs/release/migration-review.md`): dev has 21 applied rows through 0021, its catalog equals a clean 0000-0021
> install, the single hash mismatch is still row 19 (kept deliberately), and only 0022 is pending.

Scope: `apps/api/src/db/migrations`, `meta/_journal.json`, snapshots, the dev database `voice_agent_mvp`
(read-only SELECTs only), and scratch databases `voice_agent_scratch_*` (dropped afterwards).
Server: PostgreSQL 16.14 (container `voice-agent-postgres`, host port 5440).

## 1. Journal, files, snapshots, applied set

* Journal idx run 0-15 and 17-21 (as of this writing 0020 `entitlement_seat_caps` and 0021 `stream_grants` were
  added by concurrent work). **There is no 0016**: no sql file, no snapshot, no journal entry. This is harmless:
  drizzle's migrator does not require contiguous numbers. It reads the journal in order, takes each entry's
  `when` (folderMillis) and applies every entry whose `when` is greater than the newest `created_at` row in
  `drizzle.__drizzle_migrations`. Verified: a clean scratch database migrated through the gap to the last entry
  (journal entry count == applied row count). `drizzle-kit check` and `drizzle-kit generate` (run in a scratch
  copy) report "Everything's fine" and "No schema changes". Every journal entry has a sql file and a snapshot.
  Do not renumber or "fill" 0016: the `when` values are what the migrator compares, not the number.
* Hash check (sha256 of each .sql file, which is what drizzle stores in `hash`; `created_at` equals `when`):
  dev DB rows 1..19 equal journal entries 0..15,17,18,19 for **18 of 19 entries**. The single mismatch is
  **0019_billing_foundation**: dev stored `1475aeff...63659a0`, the file now hashes to `001e87ca...`.
  The 0019 file was edited after it was applied to dev (it was applied accidentally, see section 4, while it was
  still an earlier draft). Drizzle does not re-check hashes of applied rows, so this is silent.
* Dev DB is **not at head**: 19 applied rows (newest `created_at` 1791981624983 = 0019); 0020 and 0021 are
  pending and would be applied by the next `db:migrate` against it.

### Dev schema vs a freshly migrated scratch database

Compared: normalised `pg_dump --schema-only` (diffed), `pg_dump` ACL/owner lines, and catalog queries (RLS flags,
policies, grants, functions, triggers, roles). Everything is identical EXCEPT the following, all caused by dev
having run an earlier draft of 0019 (the clean database was built from 0000-0020 at the time of comparison):

| Object | Dev (`voice_agent_mvp`) | Clean install (current 0019) |
|---|---|---|
| `subscriptions`, `usage_ledger`, `billing_events` | **RLS not enabled, not forced, no policy** | RLS enabled and forced, `tenant_isolation` policy |
| `plans` (global catalog) | `voice_app` has SELECT, INSERT, UPDATE, DELETE | `voice_app` SELECT only |
| `usage_ledger`, `billing_events` | `voice_app` SELECT, INSERT, UPDATE, **DELETE** | SELECT, INSERT, UPDATE (no DELETE) |
| CHECK constraints | `plans_minutes_nonnegative`, `plans_price_nonnegative`, `subscriptions_period_order`, `usage_ledger_entry_type`, `usage_ledger_nonnegative` missing | present |
| Functions/triggers | `usage_ledger_guard`, `billing_cap_for`, `billing_enforce_agent_cap`, `billing_enforce_member_cap` and 4 triggers missing | present |
| `plans` rows | 0 | 5 (trial, starter, growth, business, enterprise) |

Consequence: dev is **less protected** than head for the billing tables (cross-tenant visibility to `voice_app`,
writable catalog, deletable ledger, no seat-cap or append-only triggers). Tests use `voice_agent_test*` databases
built from the migration files and are correct; anything run against dev is NOT evidence about the head schema.
Fixing dev is a decision for the owner (options in section 4).

## 2. Catalog of the dev DB (current live state)

Roles (cluster-wide):

| Role | super | createrole | createdb | bypassrls | login | notes |
|---|---|---|---|---|---|---|
| voice_agent | yes | yes | yes | yes | yes | owner of every object, used for migrations |
| voice_app | no | no | no | no | yes | restricted runtime role; no CREATE on `public`, no USAGE on schema `drizzle` |
| voice_app_dev | no | no | no | no | yes | dev login, member of `voice_app` (inherits) |
| voice_resolver | no | no | no | no | NOLOGIN | owns the `app_resolve_*` / `app_list_stale_calls` SECURITY DEFINER functions; `resolver_lookup` SELECT policies on projects, calls, agent_phone_numbers, invitations |
| voice_retention | no | no | no | no | NOLOGIN | owns `app_purge_security_events`; SELECT/UPDATE/DELETE policies on `security_events`, INSERT on `security_events_archive` |

Default privileges (owner `voice_agent`): tables give `voice_app` arwd, sequences give `voice_app` rU. Every NEW
table therefore starts with full DML for `voice_app` and must be narrowed by its own migration (this is why
`plans` is explicitly REVOKEd in 0019). There are no sequences in `public`.

Tables (all owned by `voice_agent`); `voice_app` privileges as in dev right now:

| Table | RLS enabled / forced | voice_app | Policies |
|---|---|---|---|
| agent_configs, agent_knowledge_bindings, agents, conversations, follow_ups, leads, organization_modules, project_knowledge, project_members, site_visits | t / t | SIUD | `tenant_isolation` (ALL, org = app_current_org()) |
| agent_phone_numbers, calls, projects, invitations | t / t | SIUD | `tenant_isolation` + `resolver_lookup` (SELECT, voice_resolver) |
| audit_logs, usage_events | t / t | S, I | `tenant_isolation` |
| memberships | t / t | SIUD | `memberships_select/insert/update/delete` |
| organizations | t / t | SIUD (policies allow select and update only) | `organizations_select`, `organizations_update` |
| security_events | t / t | S, I (retention: S, D) | `security_events_select/insert`, `retention_select/lock/delete` |
| security_events_archive | t / t | none (retention: I) | `retention_archive_insert` |
| auth_throttle, mfa_recovery_codes, rate_limit_buckets, sessions, stream_claims, stream_token_uses, users | f / f | SIUD | none (global/auth tables, accessed by key, not tenant) |
| billing_events, subscriptions, usage_ledger | **f / f in dev** (t / t at head) | SIUD in dev | none in dev (`tenant_isolation` at head) |
| plans | f / f (global catalog, intentionally not tenant scoped) | **SIUD in dev**, SELECT only at head | none |

Functions in `public`: `app_current_org`, `app_current_user` (invoker; EXECUTE for voice_app and voice_resolver,
not PUBLIC); `app_resolve_*` x5 and `app_list_stale_calls` (SECURITY DEFINER, owner voice_resolver,
`search_path=pg_catalog, public`, EXECUTE for voice_app and voice_resolver, not PUBLIC);
`app_purge_security_events` (SECURITY DEFINER, owner voice_retention, EXECUTE voice_app and voice_retention);
`app_security_event_category` (invoker helper, PUBLIC executable, `search_path=pg_catalog`).
Head additionally has `billing_cap_for`, `billing_enforce_agent_cap`, `billing_enforce_member_cap`,
`usage_ledger_guard` (invoker, owner voice_agent, PUBLIC EXECUTE by default; only reachable as triggers or read
RLS-protected tables as the caller, so PUBLIC EXECUTE exposes nothing).

What `voice_app` can do with the global `plans` catalog: at head SELECT only (0019 REVOKEs INSERT/UPDATE/DELETE);
in dev currently full DML (finding above). No RLS on `plans`: deliberately readable by all tenants.

## 3. Clean install and upgrade equivalence (tests)

Added to `apps/api/src/db/migration-upgrade.test.ts` (each run uses its own database
`voice_agent_upgrade_test_<pid>`; the previous fixed name made concurrent runs drop each other's database):

1. Upgrade from 0011 (with legacy data) to head yields the same catalog as a clean install: columns, tables
   (RLS, force, owner, ACL), policies (qual and with-check), functions (owner, secdef, ACL, source md5),
   triggers, constraints, indexes, plan catalog, and identical `drizzle.__drizzle_migrations` rows; asserts the
   journal has no idx 16.
2. Re-running the migrator (twice more) changes neither catalog nor journal rows.
3. Emergency rollback of 0012 (scratch only). `0012_row_level_security.down.sql` is **partial by design**: it
   only disables RLS on the 18 tables 0012 created policies for. It does NOT cover `security_events*`,
   `subscriptions`, `usage_ledger`, `billing_events` (their RLS stays on).
   **Finding:** re-running `0012_row_level_security.sql` after a rollback (the previously documented recovery)
   restores RLS and policies, but its blanket `GRANT` re-widens privileges that 0013/0015/0019 narrowed
   (security_events, usage_ledger, archive, ...). New script
   `apps/api/src/db/rollback/0012_row_level_security.reenable.sql` only re-issues ENABLE/FORCE and is tested to
   restore the head catalog exactly. Use it, not 0012, to recover. The test also pins the widening behaviour of
   re-running 0012 so it cannot change silently. `docs/security/rls-rollout.md` still mentions re-applying 0012;
   treat this document as authoritative (that file was outside this task's edit scope).

Run: `TEST_DATABASE_NAME=voice_agent_test_mig npx vitest run src/db/migration-upgrade.test.ts
src/db/migrate-guard.test.ts src/db/rls.test.ts` -> 3 files, 40 tests passed.

## 4. The accidental migration run and the recovery position

What happened: an e2e runner applied the pending migrations 0017-0019 to the dev database through
`DATABASE_MIGRATION_URL` read from the repo-root `.env` (dotenv never overrides, so the runner's own
`DATABASE_URL` pointing at a throw-away database did not win). `apps/web/e2e/run.mjs` now pins `DATABASE_URL`
and `DATABASE_MIGRATION_URL` explicitly, and `migrate.ts` has a guard (section 5).

Verified position of `voice_agent_mvp` (read-only):

* Applied rows: 19, newest 0019 (hash differs from the current file, section 1). 0020/0021 NOT applied.
* Row counts equal the pre-RLS backup (organizations 1, users 1, memberships 1, projects 1, leads 6, calls 182,
  agents 2, conversations 182): the migrations were additive; no data was lost or altered.
* Backup `db-backups/voice_agent_mvp_pre-rls_20261014_180526.dump` (custom format, 175037 bytes, archive created
  2026-10-14 12:35:26 UTC), sha256 `56a0e88ec02020432d6ec8c77f521e875abe3f38b0a0ed2efe30d4e783dc909d`, matches
  the `.sha256` file. Restored into a scratch database with `pg_restore --no-owner`: exit 0; it holds migrations
  up to 0011 only (12 journal rows, newest 1791900758199), 19 tables, RLS off, 0 policies, data counts as above.
* Objects in dev but NOT in the dump (lost on a restore): everything from 0012-0019: RLS flags and policies,
  functions `app_*`, tables `auth_throttle, mfa_recovery_codes, security_events, security_events_archive,
  stream_claims, stream_token_uses, rate_limit_buckets, plans, subscriptions, usage_ledger, billing_events`,
  columns added to existing tables, `drizzle` rows 13-19, and any sessions or security events created after
  18:05 IST. Roles are cluster-level and are not in a per-database dump (they persist on this server).
* An older dump also exists, `voice_agent_mvp-pre-phase2-20261006-104947.dump` (not verified here).

Recovery options (none executed against dev here):

1. Go forward (keeps data). Back up first (`pg_dump -Fc`), then either (a) restore the 0011 dump into a new
   database, run `db:migrate` with `MIGRATION_TARGET_CONFIRM=<new db>`, re-seed (1 org, 1 user), or (b) hand-apply
   the hardening part of `0019_billing_foundation.sql` (CHECKs, tenant RLS block, REVOKEs, guard function and
   trigger, plans seed) plus 0020/0021 to dev in one transaction and correct the stored 0019 hash row
   (`update drizzle.__drizzle_migrations set hash = <sha256 of file> where created_at = 1791981624983`).
2. Roll back to pre-RLS (destructive for post-18:05 data): `pg_restore --no-owner` the dump into a new database
   (tested in scratch), repoint `.env`, drop the old database after verification. The 0012 down script does NOT
   undo 0013-0019 (additive tables and columns stay); it only switches tenancy enforcement off.
3. Emergency RLS off/on: `rollback/0012_row_level_security.down.sql`, then
   `rollback/0012_row_level_security.reenable.sql` (scratch-tested; supersedes re-running 0012).

## 5. Migration runner guard

`apps/api/src/db/migrate-guard.ts` (used by `migrate.ts`; tests in `migrate-guard.test.ts`):

* Prints `Migration target: host:port/db (user: name)` before migrating; never prints the password.
* If both `DATABASE_URL` and `DATABASE_MIGRATION_URL` are set and differ in host, port or database name it
  refuses unless `MIGRATION_TARGET_CONFIRM=<database name of DATABASE_MIGRATION_URL>`. The same database with a
  different user (runtime role vs owner) is the normal case and is allowed. `localhost` equals `127.0.0.1`.
* Verified end to end against scratch databases: mismatch exits with the error; with confirmation it migrates.
* Limits: it protects `db:migrate` only. A developer running drizzle-kit `push`/`migrate` directly bypasses it.
