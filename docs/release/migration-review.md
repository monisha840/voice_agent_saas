# Migration review: release candidate (0000 to 0022)

> **Historical record - read with the 2026-10-21 correction.** Every observation below is from 2026-10-14, when the
> head of the committed set was 0022 and the dev database was at 0021. Since then 0022, 0023 (knowledge base) and
> 0024 (number management) were committed in `0432360` and applied to dev, and a further migration is in progress.
> The review's *method and conclusions* still stand; its *counts and "dev is at ..." statements do not*. For the
> real numbers at any time: head of the committed set is
> `node -e 'const j=require("./apps/api/src/db/migrations/meta/_journal.json");console.log(j.entries.length, j.entries.at(-1).tag)'`,
> and what a database has applied is `select count(*), max(created_at) from drizzle.__drizzle_migrations;`.

Date: 2026-10-14 (work window 15:13 to 15:25 UTC). Server: PostgreSQL 16.14, container `voice-agent-postgres`
(host port 5440). Scope: `apps/api/src/db/migrations` (SQL, `meta/_journal.json`, `meta/*_snapshot.json`),
`apps/api/src/db/rollback/*`, the guarded migrator `apps/api/src/db/migrate.ts` + `migrate-guard.ts`.

Ground rules followed: the dev database `voice_agent_mvp` was used **read-only** (SELECT, `pg_dump`); 0022 was
**not** applied to it; `drizzle.__drizzle_migrations` was not modified anywhere except in disposable databases.
All execution used disposable databases `voice_agent_scratch_rc_{fresh,upg,devcopy,ref0021}` plus the test database
`voice_agent_test_rcmig`; all of them, and the throwaway login role `rc_probe_app`, were dropped at the end.
Nothing was committed or pushed.

## Summary

| Check | Result |
|---|---|
| Journal / files / snapshots 0000-0022 | 22 entries, idx 0-15 and 17-22; every entry has its SQL file and snapshot; `prevId` chain unbroken; `drizzle-kit check`: "Everything's fine" |
| Dev DB state | 21 applied rows (0000-0021), 0022 absent. Catalog equals a clean 0021 install exactly, except the stored hash of 0019 (pre-existing, preserved) |
| Dev DB untouched | normalised `pg_dump --schema-only` sha256 identical at start and end (`941fc8da...2a1820`) |
| (a) Fresh install 0000->0022 | OK via the guarded migrator; re-run is a no-op |
| (b) Upgrade 0021 + data -> 0022 | OK; data checksum unchanged by 0022 |
| (c) Copy of dev -> 0022 | OK; exactly the 3 expected privilege changes; old 0019 hash row untouched |
| (d) Catalog (a) vs (b) | identical (catalog query set and normalised schema dump) |
| Restricted-role probes | RLS fail-closed on all 23 RLS tables, cross-tenant read/write blocked, 0022 grants as intended, forward-only ledger, `plans` read-only |
| Vitest (required command) | 3 runs: 74/74, 73/74 (one timeout), 74/74. See section 5 |
| Defects | D1 0022 rollback script not catalog-exact; D2 `migration-upgrade.test.ts` timing flake; D3 two docs are stale about dev; D4 owner `TRUNCATE` bypasses the ledger guard. None blocks applying 0022 |

## 1. Sequence 0000-0022

### Journal, files, snapshots

All 22 journal entries have `breakpoints: true`. Snapshot chain: `0000.prevId = 00000000-...` and every later
snapshot's `prevId` equals the previous snapshot's `id`, **including across the gap** (0017.prevId = 0015.id).
`npx drizzle-kit check` (apps/api): "Everything's fine".

| idx | tag | when (folderMillis) | when (UTC) | sha256 of SQL (first 12) | snapshot id | prevId |
|---|---|---|---|---|---|---|
| 0-11 | 0000_brown_sasquatch ... 0011_fluffy_owl | 1791116333578 ... 1791900758199 | 2026-10-04 ... 2026-10-13 | all equal to dev rows 1-12 | chain from `17ebbb6f` to `e7d5829e` | continuous |
| 12 | 0012_row_level_security | 1791968272247 | 2026-10-14 08:57:52.247 | fc098fee36b4 | b0d0d12e-e0e1-4094-ad52-4db4a2342166 | e7d5829e (0011) |
| 13 | 0013_auth_security | 1791971730960 | 2026-10-14 09:55:30.960 | 4e4a97f2f58d | 2b431a4b-051f-4301-8988-9a7fe437b0a8 | b0d0d12e (0012) |
| 14 | 0014_stream_tokens | 1791978133601 | 2026-10-14 11:42:13.601 | 422b05615f5b | fdedbba1-4039-4e56-a5bb-65005529ad20 | 2b431a4b (0013) |
| 15 | 0015_security_event_retention | 1791978528052 | 2026-10-14 11:48:48.052 | de3e00ff9456 | 15cb4b31-b581-45a5-a66d-cc22a6c106c4 | fdedbba1 (0014) |
| 16 | **none (intentional gap)** | - | - | - | - | - |
| 17 | 0017_stream_claims | 1791981395942 | 2026-10-14 12:36:35.942 | dc0c9c03d7a9 | 1b56025f-24c0-48da-b04b-5b70f2b1db81 | 15cb4b31 (0015) |
| 18 | 0018_rate_limit_buckets | 1791981454540 | 2026-10-14 12:37:34.540 | 87304c80fb2e | 657feb9c-a0f2-4c67-803c-0feccddcba7d | 1b56025f (0017) |
| 19 | 0019_billing_foundation | 1791981624983 | 2026-10-14 12:40:24.983 | 001e87ca3e84 | baae2766-f66a-4e23-8209-f75e7e895c37 | 657feb9c (0018) |
| 20 | 0020_entitlement_seat_caps | 1791984880537 | 2026-10-14 13:34:40.537 | a77962de8566 | 6fe6d134-ee87-4e6d-9e9a-31293e6bde24 | baae2766 (0019) |
| 21 | 0021_stream_grants | 1791984931706 | 2026-10-14 13:35:31.706 | faafb80a640d | 5bf184d4-a5ca-4991-97d5-a3925773e71c | 6fe6d134 (0020) |
| 22 | 0022_billing_grants_hardening | 1791987201799 | 2026-10-14 14:13:21.799 | 2ad5a313b8ad | 18e721d7-273b-4614-b2ca-ea37b5546fe6 | 5bf184d4 (0021) |

Snapshot content (structural diff, ignoring id/prevId): 0019->0020 and 0021->0022 are identical. That is correct:
0020 adds only functions/triggers and 0022 only privileges, and drizzle snapshots do not model either. 0020->0021
adds exactly `stream_grants`.

**Gap at 16.** No SQL, snapshot or journal entry. Harmless: drizzle's migrator applies every journal entry whose
`when` is greater than the newest `created_at` in `drizzle.__drizzle_migrations`; numbers are not compared. Proven
again here: fresh install produced 22 rows. Do not renumber or "fill" 16.

### Per-migration review, 0012-0022

"Re-run" = the whole file executed a second time against a head database inside a rolled-back transaction
(`BEGIN; <file>; ROLLBACK;`, `ON_ERROR_STOP=1`). Drizzle itself never re-runs an applied file; this matters only for
hand application or recovery.

| # | Purpose | Objects created / changed | Hand-written part idempotent? (measured) | Rollback coverage |
|---|---|---|---|---|
| 0012 | DB-enforced tenant isolation | roles `voice_app`, `voice_resolver` (if absent); `app_current_org()`, `app_current_user()`; ENABLE+FORCE RLS and `tenant_isolation` on 16 tables; split policies on `memberships` (4) and `organizations` (2); `resolver_lookup` policies on projects/calls/agent_phone_numbers/invitations; column SELECT grants to `voice_resolver`; 5 `app_resolve_*` + `app_list_stale_calls` (SECURITY DEFINER, owner voice_resolver, `search_path=pg_catalog, public`, EXECUTE voice_app only); blanket DML grant + default privileges for voice_app; REVOKE UPDATE/DELETE on audit_logs, usage_events | Whole file is hand-written. Re-run: OK. **But** re-running re-widens grants narrowed by 0013/0015/0019/0022 (known, pinned by a test) | `rollback/0012_row_level_security.down.sql` (partial by design: RLS off on the 18 tables 0012 covers; not security_events*, billing tables). Recover with `rollback/0012_row_level_security.reenable.sql`, never by re-running 0012 |
| 0013 | Auth hardening, security audit log | tables `auth_throttle`, `mfa_recovery_codes`, `security_events`; columns `sessions.last_auth_at`, `sessions.mfa_verified_at`, `users.password_changed_at/mfa_secret_enc/mfa_enabled_at/mfa_last_step`; FKs, 5 indexes; RLS+FORCE on `security_events` with `security_events_select/insert`; REVOKE UPDATE/DELETE/TRUNCATE on it; DML on throttle/recovery codes | Whole file re-run: **fails** (`column "last_auth_at" ... already exists`, generated ADD COLUMN). Hand-written RLS/grant tail re-run: OK | none (additive) |
| 0014 | Stream token replay protection | table `stream_token_uses` + index; DML grant | Re-run fails (generated CREATE TABLE). Grant line idempotent | none (additive) |
| 0015 | Security-event retention | role `voice_retention`; table `security_events_archive` + index, RLS+FORCE, `retention_archive_insert`; `retention_select/lock/delete` on security_events; column grant UPDATE(id); `app_security_event_category()`, `app_purge_security_events()` (SECURITY DEFINER, owner voice_retention) | Re-run: OK (IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE throughout) | inline comment only (`DROP FUNCTION app_purge_security_events(...)`); no script |
| 0017 | Media-stream single-owner claims | table `stream_claims` + index; DML grant | Re-run fails (generated CREATE TABLE) | none (additive) |
| 0018 | Shared rate-limit buckets | table `rate_limit_buckets` + index; DML grant | Re-run fails (generated CREATE TABLE) | none (additive) |
| 0019 | Billing foundation | enums `subscription_status`, `usage_ledger_state`; tables `plans`, `subscriptions`, `usage_ledger`, `billing_events`; FKs, 7 indexes; CHECKs `plans_price_nonnegative`, `plans_minutes_nonnegative`, `subscriptions_period_order`, `usage_ledger_nonnegative`, `usage_ledger_entry_type`; RLS+FORCE+`tenant_isolation` on the 3 tenant tables; REVOKE write on `plans`, DELETE on ledger/events; `usage_ledger_guard()` + `usage_ledger_guard_trg`; 5 seeded plans (`ON CONFLICT DO NOTHING`) | Whole file re-run fails (generated CREATE TYPE). Hand-written part from its header: **fails at the CHECK constraints** (`plans_price_nonnegative already exists`); from the RLS block onward: OK | `rollback/0019_0020_billing.down.sql` (destructive: drops billing tables/data; then delete the 0019/0020 rows from the journal table). Tested by `billing-migration.test.ts` |
| 0020 | Plan seat caps in the DB | `billing_cap_for()`, `billing_enforce_agent_cap()`, `billing_enforce_member_cap()`; triggers `billing_agent_cap_trg` (agents), `billing_member_cap_trg` (memberships), `billing_invitation_cap_trg` (invitations) | Re-run: OK | same script as 0019 (or drop only the three triggers, non-destructive) |
| 0021 | Per-call stream grants | table `stream_grants` + index; DML grant | Re-run fails (generated CREATE TABLE) | none (additive) |
| 0022 | Narrow billing write privileges | REVOKE UPDATE on `billing_events`; REVOKE UPDATE on `usage_ledger`; GRANT UPDATE(`state`) on `usage_ledger` (all for voice_app). Nothing else | Re-run: OK, catalog unchanged (measured) | `rollback/0022_billing_grants_hardening.down.sql`: **not catalog-exact** (defect D1); exact SQL in section 6 |

### The 0019 hash discrepancy on dev (preserve, do not rewrite)

Dev row 19 stores `1475aeff3a4fb0c4d4d48abd06c40bd4176d3bec245604b491ce6730863659a0`; the current
`0019_billing_foundation.sql` hashes to `001e87ca3e84d53f19676703e03cc3486eda8647a828eb3df098da94da293f17`. The file
was edited after an accidental early application to dev (`docs/security/migration-reconciliation.md` section 4).
Drizzle does not re-verify hashes of applied rows; it compares only `created_at` against `when`. The pending step
therefore works on dev (proven in 3(c)). Leave the row as it is. Do not edit 0019 to match it, and do not rewrite the
stored hash as part of the 0022 change.

## 2. Dev database status (read-only)

Applied rows (`select id, hash, created_at from drizzle.__drizzle_migrations order by id`), matched to the journal
by `created_at = when`. Note that drizzle stores the journal's `when` in `created_at`, so it is the migration's
authoring time, not the time it was applied.

| id | journal idx | tag | created_at | hash vs file |
|---|---|---|---|---|
| 1-12 | 0-11 | 0000_brown_sasquatch ... 0011_fluffy_owl | 1791116333578 ... 1791900758199 | match (all 12) |
| 13 | 12 | 0012_row_level_security | 1791968272247 | match |
| 14 | 13 | 0013_auth_security | 1791971730960 | match |
| 15 | 14 | 0014_stream_tokens | 1791978133601 | match |
| 16 | 15 | 0015_security_event_retention | 1791978528052 | match |
| 17 | 17 | 0017_stream_claims | 1791981395942 | match |
| 18 | 18 | 0018_rate_limit_buckets | 1791981454540 | match |
| 19 | 19 | 0019_billing_foundation | 1791981624983 | **MISMATCH** (stored 1475aeff..., file 001e87ca...) |
| 20 | 20 | 0020_entitlement_seat_caps | 1791984880537 | match |
| 21 | 21 | 0021_stream_grants | 1791984931706 | match |

Count = **21**, max(created_at) = 1791984931706 (= 0021). **0022 not applied** (only unapplied journal entry).

Dev catalog vs a clean 0000-0021 install (`voice_agent_scratch_rc_ref0021`), using the 14-part catalog query in
section 3(d): **identical except the 0019 hash row**. So dev has been reconciled since
`migration-reconciliation.md` was written: billing RLS, CHECKs, guard and cap triggers, plans seed and narrowed
grants are all present (see D3). Dev data (owner view): organizations 1, users 1, calls 182, conversations 182,
usage_events 472, audit_logs 390, leads 6, subscriptions/usage_ledger/billing_events 0, plans 5.

Vs head (fresh 0022 install) the only differences are the 0022 privileges and the 0019 hash/0022 row:

```
billing_events  voice_app=arw  -> voice_app=ar
usage_ledger    voice_app=arw  -> voice_app=ar  + column ACL usage_ledger.state {voice_app=w}
```

**Schema fingerprint.** `docker exec voice-agent-postgres pg_dump -U voice_agent -d voice_agent_mvp --schema-only`.
Normalisation strips CR, `--` comment lines, the per-dump random `\restrict`/`\unrestrict` nonce lines and blank
lines (`tr -d '\r' | grep -v -e '^--' -e 'restrict [A-Za-z0-9]*$' | awk 'NF' | sha256sum`), leaving 1110 lines:

| When | sha256 (normalised) |
|---|---|
| start, 15:13 UTC, before any other action | `941fc8da7233fc227d17c7abaa1e5e8be68f393ba1e0a14322b3e4890d2a1820` |
| end, 15:24 UTC, after all scratch work and cleanup | `941fc8da7233fc227d17c7abaa1e5e8be68f393ba1e0a14322b3e4890d2a1820` |

`diff` of the two normalised dumps is empty. The migration rows are also unchanged: 21 rows, same ids, hashes and
created_at as at start (md5 of `id||hash||created_at` at end: `63781e9ccc7cbe32183cc93b1f9dfa1f`).

## 3. Disposable databases

All migrations ran through the real guarded runner with explicit environment variables, which dotenv does not
override:
`DATABASE_URL=<owner>/<db> DATABASE_MIGRATION_URL=<owner>/<db> [MIGRATION_TARGET_CONFIRM=<db>] npx tsx src/db/migrate.ts`.

**(a) Fresh install 0000->0022** (`voice_agent_scratch_rc_fresh`). Exit 0, 22 rows, max created_at 1791987201799.
A second run was a no-op (exit 0, still 22 rows). Guard check: `DATABASE_URL=.../rc_upg` with
`DATABASE_MIGRATION_URL=.../rc_fresh` and no confirmation gave "Refusing to migrate: DATABASE_URL targets ...", exit 1.

**(b) Upgrade path** (`voice_agent_scratch_rc_upg`). Migrated to 0021 with the drizzle migrator on a scratchpad copy
of the folder whose journal stops at idx 21 (21 rows, voice_app had table UPDATE on both billing tables). Seeded as
owner: 2 organizations (A, B), 2 users, 2 OWNER memberships, 2 agents, 2 completed calls, 2 active subscriptions
(starter, growth), 3 ledger rows (A: final + pending, B: final), 2 billing events. Then 0022 was applied with the
real runner and `MIGRATION_TARGET_CONFIRM=voice_agent_scratch_rc_upg`. Result: exit 0, row 22 = `2ad5a313...`. The
data checksum (md5 over `to_jsonb` of organizations, users, memberships, subscriptions, usage_ledger, billing_events,
plans) was `181725a0ef59d947e9e63142b93fb19a` before and after.

**(c) Copy of dev** (`voice_agent_scratch_rc_devcopy`). `pg_dump -Fc` of `voice_agent_mvp` (read-only; 249346 bytes,
sha256 `74ede96c...0ccf`, temp file inside the container, deleted afterwards). `pg_restore --exit-on-error` restored
it with owners and ACLs (exit 0): 21 rows, row 19 hash `1475aeff...` (the dev discrepancy), data intact. Then the
real runner applied the pending step. **Result: exit 0, applied only 0022 (row 22 `2ad5a313...`), rows 1-21
including the old 0019 hash unchanged.** Normalised schema diff before/after 0022 on the copy is exactly:

```
- GRANT SELECT,INSERT,UPDATE ON TABLE public.billing_events TO voice_app;
+ GRANT SELECT,INSERT ON TABLE public.billing_events TO voice_app;
- GRANT SELECT,INSERT,UPDATE ON TABLE public.usage_ledger TO voice_app;
+ GRANT SELECT,INSERT ON TABLE public.usage_ledger TO voice_app;
+ GRANT UPDATE(state) ON TABLE public.usage_ledger TO voice_app;
```

The dev copy after 0022 compared with the fresh head install differs only in (i) the 0019 hash row and (ii) a
cosmetic re-deparse of the `usage_ledger_entry_type` CHECK caused by dump/restore (`ANY ((ARRAY['call'::varchar,
...])::text[])` vs `ANY (ARRAY[('call'::varchar)::text, ...])`, which are semantically the same). The live dev catalog
has the original form, identical to fresh.

**(d) Fresh (a) vs upgrade (b).** Compared with a 14-part catalog query: relations (kind, RLS enabled/forced, owner,
ACL), columns (type, nullability, default, position), column ACLs, constraints (`pg_get_constraintdef`), indexes,
policies (roles, cmd, qual, with_check), triggers (`pg_get_triggerdef`, enabled), functions (identity args, owner,
SECURITY DEFINER, ACL, proconfig, md5 of source), enums, default ACLs, schema owner/ACL, effective
`has_table_privilege` for voice_app/voice_resolver/voice_retention across 7 privileges, migration rows, plan rows.
680 lines each: **identical**. Normalised `pg_dump --schema-only` of both: **identical** (sha256 `8dd3442c...b6f8`).

## 4. Restricted runtime role probes

A throwaway role `CREATE ROLE rc_probe_app LOGIN ... NOSUPERUSER NOBYPASSRLS IN ROLE voice_app` connected over TCP with a
password (`whoami: rc_probe_app, super=f, bypassrls=f, member of voice_app=t`). Each statement ran through a
`pg_temp` helper that records `OK rows=N` or `ERR <sqlstate> <message>`. The role was dropped at the end.

Run on `rc_upg` (2 tenants, after 0022) and on `rc_devcopy` (real dev data, after 0022).

**RLS, no tenant context** (no `app.organization_id`): there are 23 RLS tables. 22 return **0 rows** on both
databases (on the dev copy this includes calls 182, conversations 182, usage_events 472, audit_logs 390,
site_visits 20 and the rest). The 23rd, `security_events_archive`, returns `ERR 42501 permission denied` (voice_app has
no privilege on it at all, by design). Every RLS table is
also FORCEd, and no table with an `organization_id` column lacks RLS. `plans` returns 5 (global catalog, no RLS by
design).

**RLS, tenant A context**: every table shows only A's rows and `count(*) where organization_id <> A` = 0 everywhere.
On the dev copy, the dev org sees all of its own data (calls 182 etc.).

**Cross-tenant writes from A against B** (rc_upg):

| Attempt | Result |
|---|---|
| UPDATE ... SET organization_id = organization_id WHERE organization_id = B (21 tables with organization_id, security_events* excluded) | 17 tables `OK rows=0`; audit_logs, usage_events, billing_events, usage_ledger: `ERR 42501 permission denied` |
| DELETE ... WHERE organization_id = B (all tenant tables) | `OK rows=0`, or `42501` where DELETE is not granted (audit_logs, usage_events, security_events, archive, billing_events, usage_ledger) |
| UPDATE organizations B | `OK rows=0` |
| Move own agent to B | `ERR 42501 new row violates row-level security policy for table "agents"` |
| INSERT for B into agents / billing_events / usage_ledger / subscriptions | `ERR 42501 new row violates row-level security policy` (each) |
| UPDATE subscriptions of B; UPDATE usage_ledger.state of B | `OK rows=0` |

**Billing grants after 0022** (own tenant; identical on rc_upg and rc_devcopy):

| Statement as runtime role | Result |
|---|---|
| UPDATE billing_events | `ERR 42501 permission denied for table billing_events` |
| DELETE / TRUNCATE billing_events | `ERR 42501` |
| INSERT billing_events (own org) | `OK rows=1` |
| UPDATE usage_ledger SET billable_seconds / organization_id / metadata | `ERR 42501 permission denied for table usage_ledger` (each) |
| UPDATE usage_ledger SET state = state, billable_seconds = 0 | `ERR 42501` |
| DELETE / TRUNCATE usage_ledger | `ERR 42501` |
| INSERT usage_ledger (own org, pending) | `OK rows=1` |
| state pending -> final | `OK rows=1` |
| state final -> pending | `ERR P0001 usage_ledger state cannot move from final to pending` |
| state final -> superseded | `OK rows=1` |
| state superseded -> final / -> pending | `ERR P0001 usage_ledger state cannot move from superseded to ...` |
| `has_table_privilege` UPDATE billing_events / UPDATE usage_ledger / `has_column_privilege` UPDATE usage_ledger.state / UPDATE .billable_seconds / DELETE usage_ledger / DELETE billing_events | f / f / **t** / f / f / f |

**Ledger guard for the owner** (`voice_agent`, superuser): DELETE gives `ERR P0001 usage_ledger rows are append-only
(corrections supersede, they never delete)`; UPDATE billable_seconds gives `ERR P0001 usage_ledger rows are immutable
except for their state`; final->pending and superseded->final are refused. Row count unchanged. Caveat: owner
`TRUNCATE usage_ledger` succeeds (tested inside a rolled-back transaction) because row-level triggers do not fire on
TRUNCATE. See D4.

**`plans`**: SELECT 5; INSERT / UPDATE / DELETE / TRUNCATE are each `ERR 42501 permission denied for table plans`.

**Application compatibility**: the only UPDATE the code issues on these tables is
`usageLedgerRepository.supersede` (`UPDATE usage_ledger SET state='superseded' WHERE organization_id, id, state ...
RETURNING id`). It needs UPDATE(state) plus SELECT, both still granted. `billing_events` and `usage_ledger` inserts use
`ON CONFLICT DO NOTHING`, which needs no UPDATE privilege. No `onConflictDoUpdate` targets either table
(`apps/api/src/db/repositories/billing.repository.ts`).

## 5. Vitest (scoped)

Command (from `apps/api`):
`TEST_DATABASE_NAME=voice_agent_test_rcmig npx vitest run src/db src/modules/billing/billing-migration.test.ts src/security/guardrails.test.ts`

| Run | Exit | Files | Tests | Notes |
|---|---|---|---|---|
| 1 (default reporter) | 0 | 7 passed | 74 passed | 34.4 s |
| 2 (`--reporter=verbose`) | 1 | 1 failed, 6 passed | 1 failed, 73 passed; 1 unhandled error | `migration-upgrade.test.ts > upgrade from 0011 produces exactly the clean-install catalog`: "Test timed out in 5000ms" (5007 ms). The unhandled `postgres connection.js: Cannot read properties of null (reading 'write')` is the aftermath of that timeout |
| 3 (`--reporter=verbose`) | 0 | 7 passed | 74 passed | 27.3 s; the same test took 2221 ms |

Files (run 3): `src/db/call-migration-0008.test.ts` (8), `src/db/migrate-guard.test.ts` (7),
`src/db/migration-upgrade.test.ts` (6), `src/db/repositories/calls.repository.test.ts` (7), `src/db/rls.test.ts`
(27), `src/modules/billing/billing-migration.test.ts` (5), `src/security/guardrails.test.ts` (14) = 74. Running the
flaky test's file alone 3 times took 2210 / 2503 / 3063 ms for that test, all passing. This is a timing flake (D2),
not a schema failure.

## 6. Migration 0022: approval and execution procedure

This is a procedure only. **It has not been executed on dev.**

**Change:** three privilege statements for `voice_app`, in one transaction: REVOKE UPDATE on `billing_events`;
REVOKE UPDATE on `usage_ledger`; GRANT UPDATE(`state`) on `usage_ledger`. It creates no objects, touches no data
and takes no long locks. `voice_app_dev` and any other login role that inherits `voice_app` are affected the same way.

**Approvals (both required, recorded in the change ticket):** the security/billing owner, who approves the privilege
change (decision 3 in `docs/billing/security-review-ws1.md`), and the database owner/operator for the target
environment (dev: the repo owner; staging: the staging DB owner). The operator who runs it must not be the only
approver. Attach the evidence (pre-check output, backup sha256, post-check output) to the ticket.

### 6.1 Pre-checks (read-only; run as the owner role)

```sql
-- P1. Applied set: dev expects 21 / 1791984931706; a staging DB built from this release expects the same before 0022.
SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;            -- dev: 21 | 1791984931706
SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = 1791987201799;  -- must be 0 (0022 absent)
-- P2. Dev only: the known 0019 hash row is present and is NOT to be changed.
SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = 1791981624983;
-- dev: 1475aeff3a4fb0c4d4d48abd06c40bd4176d3bec245604b491ce6730863659a0 ; staging (fresh): 001e87ca...
-- P3. Current privileges (expected before: t | t | t | f).
SELECT has_table_privilege('voice_app','billing_events','UPDATE'),
       has_table_privilege('voice_app','usage_ledger','UPDATE'),
       has_column_privilege('voice_app','usage_ledger','state','UPDATE'),
       has_table_privilege('voice_app','usage_ledger','DELETE');
-- P4. Billing protections from 0019/0020 are in place (expected: 3 rows t|t, 1 trigger, 4 triggers total).
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('subscriptions','usage_ledger','billing_events') ORDER BY 1;
SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;
-- P5. No long-running sessions holding locks on the billing tables.
SELECT pid, usename, state, now() - xact_start AS xact_age, query FROM pg_stat_activity
 WHERE datname = current_database() AND xact_start < now() - interval '1 minute';
```

Then confirm with no DB connection that the runner will target the intended database (from `apps/api`; prints
host:port/db and user, never the password):

```sh
npx tsx -e "import('./src/config/env.ts').then(e=>{e.loadEnv();return import('./src/db/migrate-guard.ts')}).then(g=>{const t=g.resolveMigrationTarget(process.env);console.log('target='+t.label+' user='+t.user)}).catch(e=>{console.error(e.message);process.exit(1)})"
# dev today: target=127.0.0.1:5440/voice_agent_mvp user=voice_agent
```

Stop if any check differs from the expected value.

### 6.2 Backup (owner role)

Dev:

```sh
TS=$(date -u +%Y%m%d_%H%M%S)
docker exec voice-agent-postgres pg_dump -U voice_agent -d voice_agent_mvp -Fc -f /tmp/voice_agent_mvp_pre-0022_$TS.dump
docker cp voice-agent-postgres:/tmp/voice_agent_mvp_pre-0022_$TS.dump db-backups/
docker exec voice-agent-postgres rm /tmp/voice_agent_mvp_pre-0022_$TS.dump
sha256sum db-backups/voice_agent_mvp_pre-0022_$TS.dump > db-backups/voice_agent_mvp_pre-0022_$TS.dump.sha256
docker exec -i voice-agent-postgres pg_restore -l < db-backups/voice_agent_mvp_pre-0022_$TS.dump | head -5   # archive readable
```

Staging (managed PostgreSQL): take a provider snapshot, and also run
`pg_dump "$STAGING_OWNER_URL" -Fc -f staging_pre-0022_$TS.dump` followed by `sha256sum`. Keep the backup out of the
repo commit. For a grants-only change the more practical undo is the rollback SQL below; the backup is the safety net.

### 6.3 Apply (guarded migrator only)

From `apps/api`, with the owner URL as `DATABASE_MIGRATION_URL`:

```sh
# dev (both URLs in the repo-root .env already point at voice_agent_mvp; set them explicitly anyway)
DATABASE_URL="postgresql://voice_app_dev:***@127.0.0.1:5440/voice_agent_mvp" \
DATABASE_MIGRATION_URL="postgresql://voice_agent:***@127.0.0.1:5440/voice_agent_mvp" \
MIGRATION_TARGET_CONFIRM=voice_agent_mvp \
npm run db:migrate            # = tsx src/db/migrate.ts
# staging
DATABASE_URL="$STAGING_RUNTIME_URL" DATABASE_MIGRATION_URL="$STAGING_OWNER_URL" \
MIGRATION_TARGET_CONFIRM=<staging database name> DATABASE_SSL=require npm run db:migrate
```

How `MIGRATION_TARGET_CONFIRM` works (`migrate-guard.ts`): it is consulted **only** when both URLs are set and differ
in host, port or database name. The run is then refused unless its value equals the database name of
`DATABASE_MIGRATION_URL`. When both name the same database (the normal dev case: runtime role vs owner), the guard
passes and the variable is ignored. That is why the dry-run target check in 6.1 and the printed
`Migration target: host:port/db (user: ...)` line are the operator's real confirmation. The runner then applies
**every** pending journal entry in one transaction. On dev and staging-at-0021 that is only 0022, which P1 confirms.
Do not use `drizzle-kit migrate`/`push` directly, because they bypass the guard.

Expected output: `Migration target: ... (user: voice_agent)`, `Running migrations...`, `Migrations complete.`, exit 0.

### 6.4 Post-checks (owner role)

```sql
SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations;   -- 22 | 1791987201799
SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = 1791987201799;
  -- 2ad5a313b8ad2587fbf9f891839361bd5e274f87ba0d33ddbde3fe097edf2f5a
SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = 1791981624983;  -- dev: still 1475aeff... (unchanged)
SELECT has_table_privilege('voice_app','billing_events','UPDATE')            AS be_update,      -- f
       has_table_privilege('voice_app','billing_events','INSERT')            AS be_insert,      -- t
       has_table_privilege('voice_app','usage_ledger','UPDATE')              AS ul_update,      -- f
       has_column_privilege('voice_app','usage_ledger','state','UPDATE')     AS ul_state,       -- t
       has_column_privilege('voice_app','usage_ledger','billable_seconds','UPDATE') AS ul_secs, -- f
       has_table_privilege('voice_app','usage_ledger','DELETE')              AS ul_delete,      -- f
       has_table_privilege('voice_app','plans','UPDATE')                     AS plans_update;   -- f
SELECT relname, relacl FROM pg_class WHERE relname IN ('billing_events','usage_ledger');
  -- voice_app=ar/voice_agent on both
SELECT attname, attacl FROM pg_attribute WHERE attrelid = 'usage_ledger'::regclass AND attacl IS NOT NULL;
  -- state | {voice_app=w/voice_agent}
```

Optional functional check (dev, inside a transaction that is rolled back, as `voice_app_dev`):
`BEGIN; SELECT set_config('app.organization_id','<org>',true); UPDATE billing_events SET outcome=outcome;` should
give `permission denied`; then `ROLLBACK;`. Then restart the API and smoke-test one call end-to-end, including
metering, plus one mock payment webhook. Optionally re-run the dev schema fingerprint (section 2). The expected
normalised diff is exactly the three GRANT lines shown in 3(c).

### 6.5 Rollback (owner role, one transaction)

Use this exact SQL. It restores the pre-0022 catalog exactly; verified on scratch, where the catalog equalled a clean
0021 install including the journal rows. The shipped `rollback/0022_billing_grants_hardening.down.sql` leaves a
redundant column ACL (D1).

```sql
BEGIN;
REVOKE UPDATE ("state") ON "usage_ledger" FROM "voice_app";
GRANT UPDATE ON "billing_events" TO "voice_app";
GRANT UPDATE ON "usage_ledger" TO "voice_app";
-- only if 0022 is to be re-applied later by db:migrate:
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791987201799;
COMMIT;
```

Never delete or modify any other journal row (in particular row 19 on dev). Re-applying afterwards with
`npm run db:migrate` was verified: it reproduces the head catalog. The only difference is the serial id of the new
journal row. Rolling back loosens privileges, but `usage_ledger_guard` still blocks content changes and deletes for all
roles, so record the reason in the ticket.

## 7. Findings and defects

* **D1 (low, rollback accuracy).** `apps/api/src/db/rollback/0022_billing_grants_hardening.down.sql` only re-grants
  table UPDATE. On scratch, after running it, the catalog differs from a clean 0021 install by
  `colacl|usage_ledger|state|{voice_app=w/voice_agent}`. This is functionally harmless (table-level UPDATE covers the
  column) but not an exact rollback. The same statement appears in `docs/billing/security-review-ws1.md` section 2
  ("then REVOKE UPDATE ("state") is not needed"). Fix: prepend `REVOKE UPDATE ("state") ON usage_ledger FROM voice_app;`
  (verified in 6.5). Not changed here.
* **D2 (medium for CI, test flake).** In `apps/api/src/db/migration-upgrade.test.ts:211` the test "upgrade from 0011
  produces exactly the clean-install catalog" runs under vitest's default 5000 ms timeout and takes 2.2-3.1 s
  alone. It timed out once (5007 ms) in a combined run, followed by an unhandled postgres-client error. Give it (and
  the other migration-heavy tests) an explicit timeout, e.g. `{ timeout: 30_000 }`. Not changed here.
* **D3 (docs stale).** `docs/security/migration-reconciliation.md` sections 1-2 and 4 describe dev at 19 rows and
  missing billing RLS, CHECKs, triggers and plans. `docs/billing/security-review-ws1.md` says 0020-0022 are pending.
  Verified on 2026-10-14: dev had 21 rows and was catalog-identical to a clean 0021 install apart from the 0019
  hash, so only 0022 was pending at that moment. **No longer current (2026-10-21):** 0022-0024 have since been
  committed and applied to dev; re-check with
  `select count(*), max(created_at) from drizzle.__drizzle_migrations;` rather than trusting any count written here.
  The 0019 hash discrepancy remains and is to be preserved.
* **D4 (low, design note).** `usage_ledger_guard_trg` is a row-level `BEFORE UPDATE OR DELETE` trigger, so it does not
  fire on `TRUNCATE`. The owner role can `TRUNCATE usage_ledger` (verified in a rolled-back transaction). The runtime
  role cannot (`42501`). If owner-level protection matters, add a `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger in a
  future migration. This is a policy decision, not a 0022 blocker.
* **Note (idempotency).** 0013, 0014, 0017, 0018, 0019 and 0021 cannot be re-run as whole files (generated DDL), and
  the 0019 hand-written CHECK block is not idempotent either. 0012, 0015, 0020 and 0022 re-run cleanly, but re-running
  0012 re-widens grants. None of this affects drizzle, which never re-runs applied files. It matters only for manual
  recovery: use the rollback/re-enable scripts, not re-execution.
* **Note (guard limits).** `MIGRATION_TARGET_CONFIRM` gives no protection when both URLs name the same database (the dev
  `.env` case), and `drizzle-kit` commands bypass the guard. Use the dry-run target check in 6.1.

No defect blocks applying 0022 to dev or staging under the procedure in section 6.

### Resolution after the review (integration pass, same day)

* **D1 fixed.** `rollback/0022_billing_grants_hardening.down.sql` now starts with
  `REVOKE UPDATE ("state") ON usage_ledger FROM voice_app;`. `billing-migration.test.ts` asserts that
  `pg_attribute.attacl` for `usage_ledger.state` is NULL after the rollback (the exact pre-0022 ACL);
  `security-review-ws1.md` was corrected.
* **D2 fixed.** All six tests in `migration-upgrade.test.ts` have `{ timeout: 30_000 }`; assertions unchanged.
* **D3 fixed.** Dated update notes were added to `migration-reconciliation.md` and `security-review-ws1.md`; the
  historical text is kept.
* **New test: 0021 -> 0022 with data** (the dev path, previously only exercised by hand in 3(b)/3(c)):
  `billing-migration.test.ts` "upgrade from 0021 with billing data applies only 0022 and leaves the data untouched"
  (own database `voice_agent_billing_mig0021_test`, dropped afterwards). It asserts one new journal row, an identical
  md5 digest of subscriptions/usage_ledger/billing_events, and the narrowed grants.
  Run: `TEST_DATABASE_NAME=voice_agent_test_rcfix npx vitest run src/modules/billing/billing-migration.test.ts
  src/db/migration-upgrade.test.ts` gave 2 files, 12 tests passed.
* **D4 open.** It is a policy decision (owner-level TRUNCATE protection) and is listed in `decisions.md` follow-ups.
