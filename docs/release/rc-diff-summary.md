# Release-candidate diff summary

Date: 2026-10-14. Branch `phase5-sarvam-verified`. All work is **uncommitted**; nothing was staged, committed or pushed
during this review. The proposed path list and commit split is in
[`proposed-commit-manifest.txt`](proposed-commit-manifest.txt).

## Totals

| | Files | Lines |
|---|---|---|
| Tracked, modified | 130 (incl. `.gitignore` edited in this review) | +4,114 / −1,913 (`git diff --stat`) |
| of which `pnpm-lock.yaml` | 1 | +1,408 / −1,480 |
| Tracked, deleted | 0 | — |
| Untracked, proposed for commit (excl. `docs/release/`) | 129 | 55,527 (wc -l) |
| of which drizzle snapshots `meta/00{12..22}_snapshot.json` | 10 | 38,640 |
| of which migrations SQL + rollback scripts | 10 + 4 | 778 + 81 |
| of which tests (`*.test.ts`, `*.e2e.ts`, `*.spec.ts`) | 30 | 6,669 |
| `docs/release/*` (this review + parallel agents) | 5 | in progress |

Excluding the lockfile and snapshots, the hand-written change is about **+2,700 / −430 lines in tracked files plus
about 16,900 new lines** (≈ 6,700 of them tests, ≈ 3,300 docs).

Migration sequence added: 0012, 0013, 0014, 0015, 0017, 0018, 0019, 0020, 0021, 0022. **There is no 0016** by design
(documented in `docs/security/migration-reconciliation.md`: journal, SQL and snapshots all skip it; do not renumber).
Dev DB is stated to be at 0021; 0022 is pending (see `docs/release/migration-review.md`).

## Workstreams

### 1. RLS / tenancy
- **Purpose:** database-enforced tenant isolation. App connects as restricted role `voice_app`; every authenticated
  handler runs inside `runInTenant` (set per statement); cross-tenant lookups go through narrow SECURITY DEFINER
  functions; admin connection is reserved for migrations/operator scripts/tests.
- **Key files:** `db/client.ts` (runtime vs admin pools), `db/tenant-context.ts`, `db/system-lookups.ts`,
  `db/pg-error.ts`, `auth/tenant-scoped.ts`, `auth/access.ts`, `db/migrate.ts` + `db/migrate-guard.ts`,
  `runtime/db-role-check.ts` (startup refuses owner/BYPASSRLS roles), all repositories and services wrapped in
  `tenantScoped(...)`, `scripts/provision-runtime-role.ts`, `scripts/seed.ts`/`create-org.ts`/`backfill-knowledge.ts`
  (run as admin), `config/validate.ts` (refuses `DATABASE_ADMIN_URL` in production).
- **Migrations:** `0012_row_level_security.sql` (+ `rollback/0012_*.down.sql`, `0012_*.reenable.sql`).
- **Tests added:** `db/rls.test.ts`, `security/guardrails.test.ts` (catalog, repository AST, service wrapping, direct
  DB access, HTTP surface), `db/migrate-guard.test.ts`, `db/migration-upgrade.test.ts`, `runtime/db-role-check.test.ts`;
  `test/repos.ts` gives fixtures admin-scoped repositories (33 existing files switched imports to it).
- **Docs:** `docs/security/rls-rollout.md`, `system-access.md`, `migration-reconciliation.md`, `performance.md`
  (+ `scripts/bench-secure-vs-baseline.ts`).

### 2. Auth / MFA / sessions
- **Purpose:** TOTP MFA with recovery codes, encrypted seeds (AES-256-GCM), MFA-pending session state, enforcement
  policy for owners/admins, recent re-authentication for sensitive changes, password policy (+ optional HIBP
  k-anonymity check), (account, IP)/IP/account login throttling, session listing/revocation.
- **Key files:** `auth/mfa.service.ts`, `totp.ts`, `secret-box.ts`, `password-policy.ts`, `login-throttle.ts`,
  `account.service.ts`, `auth.plugin.ts`, `auth.types.ts`, `session.service.ts`, `modules/auth/auth.routes.ts`,
  `modules/auth/account-security.routes.ts`, `shared/errors.ts` (`AuthChallengeError`), `scripts/user-admin.ts`;
  web: `login/LoginForm.tsx`, `account/security/*`, `components/Header.tsx`, `PageShell.tsx`, `lib/api.ts`,
  `middleware.ts`.
- **Migrations:** `0013_auth_security.sql` (auth_throttle, mfa_recovery_codes, security_events, user/session columns).
- **Tests added:** `modules/auth/account-security.test.ts`, `auth/password-policy.test.ts`; browser
  `apps/web/e2e/security.spec.ts` via `e2e/run.mjs` (+ `scripts/ui-e2e-setup.ts`, `playwright.config.ts`).
- **Docs:** `docs/security/mfa-and-sessions.md`, `ui-verification.md`.

### 3. Stream auth / telephony
- **Purpose:** media-stream authentication: signed per-call stream tokens (rotating keys), static-secret mode with
  age/status/account-sid restrictions, opt-in dynamic-endpoint grants (`/api/telephony/exotel/stream-url`), one
  stream per call (in-process + PostgreSQL claim with heartbeat/takeover), option to refuse direct inbound streams.
- **Key files:** `security/stream-token.ts`, `stream-grant.ts`, `stream-auth.ts`, `security/telephony-auth.ts`,
  `websocket/exotel-media-stream.handler.ts`, `modules/calls/calls.routes.ts`, `inbound.routes.ts`,
  `runtime/lifecycle.ts`, `adapters/telephony/exotel.provider.ts` + `telephony.interface.ts`,
  `scripts/exotel-preflight.ts`.
- **Migrations:** `0014_stream_tokens.sql`, `0017_stream_claims.sql`, `0021_stream_grants.sql`.
- **Tests added:** `security/stream-token.test.ts`, `stream-auth.e2e.test.ts`, `stream-hardening.e2e.test.ts`,
  `stream-grants.e2e.test.ts`, `stream-direct-disabled.e2e.test.ts`, `stream-leak-audit.e2e.test.ts`.
- **Docs:** `docs/security/exotel-auth-capabilities.md`, `exotel-staging-test-plan.md`,
  `stream-tokens-and-dependencies.md`, `stream-direct-dependencies.md`. **Externally unverified against real Exotel.**

### 4. Rate limiting
- **Purpose:** counters moved from in-memory `@fastify/rate-limit` to a PostgreSQL bucket table shared by all
  instances; per-user and per-organization budgets after the login gate; configurable fail mode (auth routes always
  fail closed); dashboard server deliberately does not forward client IP.
- **Key files:** `security/rate-limits.ts`, `app.ts` (hooks), `apps/web/src/lib/api.server.ts`;
  `@fastify/rate-limit` removed from `apps/api/package.json`.
- **Migrations:** `0018_rate_limit_buckets.sql`.
- **Tests:** `security/rate-limits.test.ts` (rewritten), `security/rate-limit-identity.test.ts`.
- **Docs:** `docs/security/rate-limiting.md`, `internal-client-ip-decision.md`.

### 5. Monitoring
- **Purpose:** Prometheus `/metrics` (bearer `METRICS_TOKEN` + private host only), counters for auth/stream denials,
  claim conflicts, DB authorization errors, role-check problems; alert rules with promtool-style tests; logger
  scrubs secret-looking keys.
- **Key files:** `runtime/metrics.ts`, `metrics.routes.ts`, `server.ts`, `shared/logger.ts`, `app.ts`.
- **Tests:** `runtime/metrics.test.ts`, `metrics.socket.test.ts`, `alert-rules.test.ts`, `security/leak-scrub.test.ts`.
- **Docs:** `docs/security/monitoring.md`, `monitoring-deployment.md`, `alert-rules.yml`, `alert-rules.test.yml`.
  **Alert delivery externally unverified.**

### 6. Retention
- **Purpose:** retention of `security_events` through one SECURITY DEFINER function owned by NOLOGIN
  `voice_retention`; janitor also purges expired sessions/rate buckets. **Deletion is OFF** unless
  `SECURITY_EVENT_RETENTION_ENABLED=true` AND an approval reference is set.
- **Key files:** `runtime/security-janitor.ts`, `security/security-events.ts`, `db/repositories/security.repository.ts`.
- **Migrations:** `0015_security_event_retention.sql`. **Tests:** `security/retention.test.ts`.
- **Docs:** `docs/security/audit-retention.md`.

### 7. Billing
- **Purpose:** plans, subscriptions (state machine), append-only usage ledger and billing events, metering of ended
  calls, entitlements engine, DB-enforced seat caps, call admission (concurrency/minutes), payment-event ingestion
  behind a provider interface (no real gateway), billing UI. Real-customer billing is **not enabled**.
- **Key files:** `modules/billing/*` (17 files), `db/repositories/billing.repository.ts`,
  `modules/calls/call-limits.ts`, `calls.service.ts` (`meterEndedCall`), `app.ts` (routes, `translatePlanCapError`),
  `db/schema.ts`; web `app/billing/*`, `app/onboarding/page.tsx`, `lib/billing.ts`, `app/usage/page.tsx`.
- **Migrations:** `0019_billing_foundation.sql`, `0020_entitlement_seat_caps.sql`,
  `0022_billing_grants_hardening.sql` (+ `rollback/0019_0020_billing.down.sql`, `rollback/0022_*.down.sql`).
- **Tests:** `billing.test.ts`, `billing-pure.test.ts`, `billing-security.test.ts`, `billing-audit.test.ts`,
  `billing-migration.test.ts`, `billing-ws1.test.ts`, `call-limits.test.ts` (updated); browser `e2e/billing.e2e.ts`
  via `e2e/billing-run.mjs` (+ `scripts/billing-ui-e2e-setup.ts`, `playwright.billing.config.ts`).
- **Docs:** `docs/billing/README.md`, `entitlement-enforcement-matrix.md`, `gateway-trust-boundary-checklist.md`,
  `security-review-ws1.md`.

### 8. Dependency upgrades
- API: fastify 4→5, @fastify/cookie 9→11, cors 9→11, formbody 7→8, websocket 10→11, drizzle-orm 0.33→0.45,
  drizzle-kit 0.24→0.31, vitest 2→4; added jose, otpauth, qrcode (+ @types/qrcode); removed @fastify/rate-limit.
- Web: next 14→15.5, react/react-dom 18→19, eslint-config-next 15, postcss 8.5; added @playwright/test.
- `pnpm-workspace.yaml`: overrides for postcss (next), esbuild (@esbuild-kit), postcss-selector-parser (dev advisories).
- Code fallout: Fastify 5 `trustProxy` hop predicate and websocket `errorHandler` (`app.ts`); Next 15 async
  `params`/`searchParams`/`cookies()` in 6 pages and `lib/api.server.ts`; `next-env.d.ts` regenerated.
- Docs: `docs/security/dev-dependencies.md` (remaining dev-only `braces` advisory).

### 9. CI and docs
- `.github/workflows/security.yml` (new). `ci.yml` unchanged in this tree (see `docs/release/ci-coverage.md`).
- `docs/staging-readiness-report.md`, `docs/security/ci.md`, `operations-and-validation-plan.md`.
- `.gitignore`: additions from this review (see "Exclusions").

## Config / environment variables added (from `config/env.ts` diff and new modules)

| Area | Variables (default) |
|---|---|
| Database roles | `DATABASE_ADMIN_URL` (operator/tests only; refused in production), `DATABASE_MIGRATION_URL`, `VOICE_APP_PASSWORD` (provision script) |
| MFA / auth | `MFA_ENCRYPTION_KEY` (base64 32 bytes; required to enrol), `MFA_ENFORCEMENT` (warn), `MFA_ISSUER`, `REAUTH_WINDOW_MS` (10 min), `MFA_PENDING_TTL_MS` (10 min), `PASSWORD_MIN_LENGTH` (10), `PWNED_PASSWORDS` (off) |
| Login throttle | `LOGIN_PAIR_THRESHOLD` (5), `LOGIN_IP_THRESHOLD` (30), `LOGIN_ACCOUNT_THRESHOLD` (20), `LOGIN_BASE_LOCK_MS`, `LOGIN_MAX_LOCK_MS`, `LOGIN_FAILURE_WINDOW_MS` |
| Rate limits | `RATE_LIMIT_FAIL_MODE` (open), `RATE_LIMIT_USER_MAX` (300), `RATE_LIMIT_ORG_MAX` (1500) |
| Stream auth | `STREAM_TOKEN_KEYS` (**required in production with Exotel**), `STREAM_TOKEN_TTL_MS`, `STREAM_TOKEN_MAX_USES`, `STREAM_ALLOW_STATIC_SECRET` (true), `STREAM_INBOUND_DIRECT_ALLOWED` (true), `STREAM_INBOUND_MAX_AGE_MS`, `STREAM_FLOW_MAX_AGE_MS`, `STREAM_STATIC_REQUIRE_PENDING_STATUS` (false), `STREAM_ALLOWED_ACCOUNT_SIDS`, `STREAM_CLAIM_STALE_MS`, `STREAM_CLAIM_HEARTBEAT_MS`, `STREAM_GRANT_TTL_MS`, `STREAM_GRANT_MAX_USES`, `STREAM_REQUIRE_GRANT` (false) |
| Monitoring | `METRICS_TOKEN` (unset = /metrics 404) |
| Retention | `SECURITY_EVENT_RETENTION_ENABLED` (false), `_APPROVAL_REF`, `_ARCHIVE`, `_DAYS_{AUTH_SESSION,MFA_CONFIG,ACCESS_DENIED,PRIVILEGED_ACTION,OTHER}`, `_BATCH_SIZE`, `_MAX_BATCHES` |
| Billing | `BILLING_ENFORCEMENT` (enforce), `BILLING_ADMISSION_RESERVE_SECONDS`, `BILLING_MIN_ANSWERED_SECONDS`, `BILLING_BILL_CONNECTED_FAILED_CALLS` |

`.env.example` documents the DB roles, `METRICS_TOKEN`, MFA key/enforcement, `PWNED_PASSWORDS` and login thresholds,
but **not** the `STREAM_*`, retention, billing, `RATE_LIMIT_{FAIL_MODE,USER_MAX,ORG_MAX}`, `MFA_ISSUER`,
`REAUTH_WINDOW_MS`, `MFA_PENDING_TTL_MS` or `PASSWORD_MIN_LENGTH` variables (they are documented in
`docs/security/*` and `docs/billing/*`). See problem P3.

## Overlapping edits (files touched by several workstreams)

Each was read in full diff form; hunks are coherent: no conflict markers, no duplicated blocks or re-declared
symbols, no leftover debug output.

| File | Workstreams | Result |
|---|---|---|
| `apps/api/src/app.ts` | rate limit, auth/MFA, monitoring, billing, deps (Fastify 5) | coherent; each route registered once. Cosmetic: `accountSecurityRoutes` import sits above `import Fastify` (line 1). |
| `apps/api/src/config/env.ts` | metrics, MFA, throttle, passwords, rate limit, stream, retention | coherent, additive. |
| `apps/api/src/db/schema.ts` | auth (mfa codes, security events, throttle), stream (tokens, claims, grants), rate limit, billing | no duplicate exports or table names. |
| `apps/api/src/db/migrations/meta/_journal.json` | all migrations | 0012–0022 in order, no 0016 (intended). |
| `db/repositories/security.repository.ts` (new) | auth, stream, rate limit, retention | 8 distinct repositories, no duplicates. |
| `runtime/security-janitor.ts` (new) | retention, auth sessions, rate limit | coherent. |
| `security/guardrails.test.ts` (new) | RLS, auth, stream, monitoring | coherent (14 tests); uses `typescript` (devDependency). |
| `test/setup.ts`, `test/tenants.ts`, `test/global-setup.ts` | RLS, MFA, rate limit, billing | coherent; `import { beforeAll }` placed mid-file in `setup.ts` (valid, hoisted). See P2. |
| `websocket/exotel-media-stream.handler.ts` | stream auth, monitoring, retention (security events) | coherent; claim released on both close paths. |
| `security/stream-auth.ts` | stream tokens + grants | two separate imports from `security.repository.js` (lines 23, 31), cosmetic. |
| `auth/auth.plugin.ts` | RLS (runInTenant on every route), MFA, monitoring (`/metrics` public path) | coherent. |
| `modules/calls/calls.service.ts` | RLS, billing metering, security events | coherent. |
| `.env.example` | RLS, monitoring, MFA | coherent, comments only. |
| `apps/api/package.json`, `apps/web/package.json` | deps + new scripts (`user:admin`, `db:provision-runtime-role`, `e2e`, `e2e:billing`) | coherent. |

Debug/scratch scan over all 258 changed paths: no `<<<<<<<`/`>>>>>>>`, no `console.*("DEBUG`, no `debugger`, no
`.only(`, no newly added `it.skip`/`describe.skip`/`skipIf`, no `_apply-*`/`_verify-*` scripts. The only added
`console.*` calls are intentional (`db/migrate.ts` target banner, `server.ts` refusal message).

Duplicate-source imports (valid TypeScript, cosmetic, from the mechanical switch to `test/repos.js`): e.g.
`agent-config-facade.test.ts:11-13`, `usage.test.ts:15-16`, `test/agent-first.ts:18-19`,
`follow-ups.service.ts:4,10`, `account-security.routes.ts:10,19`, `stream-auth.ts:23,31`.

## Exclusions (must not be committed)

| Path | Status |
|---|---|
| `.env` | ignored (`.gitignore:2`) |
| `.env.pre-rls.local` | ignored (`.gitignore:4`, `.env.*.local`) |
| `apps/web/.env.local` | ignored (`.gitignore:3`) |
| `apps/web/.next/`, `apps/web/tsconfig.tsbuildinfo`, `apps/api/dist/`, `node_modules/` | ignored |
| `apps/api/bench-audio/*.wav` | ignored (`.gitignore:20`) |
| `infra/docker/docker-compose.override.yml` | ignored via `.git/info/exclude` only (local to this clone) |
| `apps/web/test-results/.last-run.json` | **was NOT ignored** (showed as untracked) → now ignored by `test-results/` |
| `playwright-report/`, `blob-report/` | not present; were not ignored → now ignored |
| `../db-backups/*.dump`, `*.dump.sha256` | outside the repository (sibling folder); `*.dump`, `*.dump.sha256`, `db-backups/` added to `.gitignore` as a safeguard |
| e2e logs | written to OS temp dirs (`E2E_LOG_DIR` default `mkdtemp`), and `*.log` is ignored |
| coverage | none present; `coverage/` ignored |

`.gitignore` lines added in this review (additive only):

```
# Playwright browser e2e output (run artefacts, screenshots on failure)
test-results/
playwright-report/
blob-report/

# Database dumps / backups and their checksums (may contain tenant data; never commit)
db-backups/
*.dump
*.dump.sha256
```

No tracked file is an env file other than `.env.example` and `apps/web/.env.example`.

## Secret scan

Patterns checked over all modified and untracked files: `-----BEGIN`, `sk_live_/sk_test_`, `AKIA…`, `ghp_`, `xox?-`,
`rzp_`, 32-byte base64 literals, `*_KEY|SECRET|TOKEN|PASSWORD = "<20+ chars>"`, `postgres://user:pass@`, Sarvam and
Exotel credential assignments. **No real credentials found.** Hits are all intentional fixtures/dev defaults:

- `voice_agent:voice_agent@…` dev compose credentials (`.env.example`, `e2e/run.mjs:6,29`, `billing-run.mjs:6,23`,
  `docs/security/ui-verification.md:16`); `postgres:postgres@localhost` CI service (`security.yml:45,69,159`).
- Throw-away role passwords for disposable test databases: `e2e/run.mjs:25`, `e2e/billing-run.mjs:19`,
  `test/test-database.ts:30`, `scripts/bench-secure-vs-baseline.ts:26` (values redacted here; all `*_test_*`/`uitest`
  style strings).
- Test-only secrets/tokens in `*.test.ts` (e.g. `"a-long-…"` webhook secrets, metrics tokens); MFA/stream keys in
  tests are generated (`Buffer.alloc(32, n)`, `randomBytes(32)`), never literals.
- `.env` and `.env.pre-rls.local` were not opened (ignored, never proposed).

## Problems found

- **P1 (CI blocker, likely): `apps/web/next-env.d.ts:3` now references `./.next/types/routes.d.ts`.** On a clean
  checkout `.next/` does not exist, and `tsc --noEmit` fails with TS6053 (reproduced in an isolated scratch project).
  `ci.yml` runs `pnpm --filter @voice-agent/web typecheck` (line 67) **before** `build` (line 69). Fix options: run
  `next build` (or `next typegen`) before typecheck in CI, or keep `next-env.d.ts` at its HEAD content (Next
  regenerates it locally). Hand to the CI-coverage owner; not changed here.
- **P2 (dev-environment side effect): `apps/api/src/test/global-setup.ts`** runs
  `ALTER ROLE voice_app LOGIN PASSWORD 'voice_app_test_password'` (`test-database.ts:29-30`). Roles are
  cluster-wide and the test database lives on the same server as the dev database, so every API test run resets the
  dev cluster's `voice_app` password to a known value (a dev `DATABASE_URL` using a provisioned `voice_app`
  password stops working after tests). Not a production issue (tests never target production), but should be noted
  in the runbook or use a test-specific role name.
- **P3 (docs gap): `.env.example`** lacks `STREAM_TOKEN_KEYS`, which `config/validate.ts:162` makes **mandatory in
  production with Exotel**, and the other `STREAM_*`, retention, billing and newer rate-limit/MFA variables listed above.
- **P4 (minor): `apps/web/e2e/run.mjs:141` and `billing-run.mjs:134` set `PASSWORD_PWNED_CHECK: "off"`**, which
  nothing reads; the real variable is `PWNED_PASSWORDS`. Harmless while the default is `off`, but a developer `.env`
  with `PWNED_PASSWORDS=fail-closed` would leak into the e2e API and make it call HIBP.
- **P5 (fixed in this review): `apps/web/test-results/.last-run.json`** was untracked and not ignored; it would have
  been swept in by `git add -A`. `.gitignore` extended (see above).
- **P6 (cosmetic):** out-of-order first import in `apps/api/src/app.ts:1`; duplicate same-module imports listed above;
  mid-file `import { beforeAll } from "vitest"` in `apps/api/src/test/setup.ts`. No functional impact.
- **Resolution (integration pass):** P1: `apps/web/package.json` `typecheck` is now `next typegen && tsc --noEmit`
  (locally plain `tsc` passed even with `.next` deleted, but the clean-checkout order dependency is removed). P2: left
  as is; recorded as decision D10 in `decisions.md` (it is a test-harness role change). P3: `.env.example` now lists the
  stream, retention, billing, rate-limit and MFA variables, commented out, with no secret values. P4: both e2e runners
  now set `PWNED_PASSWORDS: "off"`. P6: not changed (cosmetic). Also changed after this review:
  `rollback/0022_billing_grants_hardening.down.sql`, `billing-migration.test.ts` (new 0021->0022 test),
  `migration-upgrade.test.ts` (timeouts), dated notes in `migration-reconciliation.md` and `security-review-ws1.md`
  (see `migration-review.md` "Resolution").
- **P7 (process):** the workstreams share 13 files, so a multi-commit split will not be bisectable; the manifest
  recommends a single commit (or the split only for review order).
