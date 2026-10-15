# CI coverage matrix (release candidate, 2026-10-14)

**GitHub CI NOT RUN.** `gh` is not installed on this machine and the working tree is uncommitted, so no workflow has
executed on GitHub. Every "COVERED" below means "a step exists in the workflow file that runs this check", not "it
passed on GitHub". Only a run URL of an observed, completed run may be recorded as a pass (see the procedure at the end
and `docs/security/ci.md`).

Workflows: `.github/workflows/security.yml` ("Security", jobs `api`, `web`, `audit`, `e2e`) and
`.github/workflows/ci.yml` ("CI", jobs `api`, `web`, `docker`). Both trigger on `pull_request` and on push to
`master`/`main`; Security also has `workflow_dispatch`. Both parse with js-yaml 4.3.2.

## Matrix

Postgres is always a `postgres:16-alpine` service container private to its job (one runner VM per job, so port 5432 in
two jobs is two different servers). Throwaway credentials `postgres/postgres`; no `secrets.*` anywhere.

| Requirement | Workflow / job / step | Command | DB / ports | Status |
|---|---|---|---|---|
| Full API tests with PostgreSQL, as restricted role | Security / `api` / `pnpm --filter @voice-agent/api test` | `vitest run` (global setup creates `voice_agent_test`, migrates it as owner, gives role `voice_app` a login; `src/test/setup.ts` points `DATABASE_URL` at `voice_app`, so RLS is enforced) | job-private server :5432; DBs `voice_agent_ci` (owner URL), `voice_agent_test` (tests); files serial (`fileParallelism: false`) | COVERED |
| Migration: fresh install | Security / `api` / "Migrations apply to an empty database, twice" (first `db:migrate`) | `pnpm --filter @voice-agent/api db:migrate` | `voice_agent_ci` on job :5432 | COVERED |
| Migration: run twice + count | same step | second `db:migrate`, then journal entries (22, head `0022_billing_grants_hardening`) must equal `select count(*) from drizzle.__drizzle_migrations` via `docker run --network host ... psql` | `voice_agent_ci` | COVERED |
| Migration: upgrade path | Security / `api` / "RLS, guardrails and migration safety suites" and "Billing suites" (also in full run) | `vitest run src/db/migration-upgrade.test.ts` (upgrade from 0011 with data, catalog equals clean install, re-run is a no-op, 0012 rollback) and `src/modules/billing/billing-migration.test.ts` (upgrade from 0018 with data through 0019-0022, 0022 as runtime role, rollback + re-apply) | per-process `voice_agent_upgrade_test_<pid>` etc. on job :5432 | COVERED (no dedicated 0021->0022-only test; 0022 is exercised in the 0018 upgrade, see gaps) |
| RLS tests | Security / `api` / named step | `vitest run src/db/rls.test.ts` (+ `migrate-guard.test.ts`) | `voice_agent_test` as `voice_app` | COVERED |
| Guardrails | Security / `api` / named step | `vitest run src/security/guardrails.test.ts` (tenant tables have RLS, tenant-addressed repos, route auth) | `voice_agent_test` | COVERED |
| Billing regression tests | Security / `api` / "Billing suites" (also in full run) | `vitest run src/modules/billing` (6 test files: `billing-audit`, `billing-migration`, `billing-pure`, `billing-security`, `billing-ws1`, `billing`) | `voice_agent_test` + disposable billing migration DBs | COVERED |
| Security Playwright e2e | Security / `e2e` / "Account security e2e (both MFA phases)" | `pnpm --filter @voice-agent/web e2e` -> `e2e/run.mjs` -> `playwright test` (`playwright.config.ts`, `*.spec.ts`), phases `off,enforce` | job-private server :5432, DB `voice_agent_ui_test`, role `voice_app_uitest`; API :4100, web :3100 (`next dev` on a temp copy) | COVERED |
| Billing Playwright e2e | Security / `e2e` / "Billing UI e2e (production web build)" | `pnpm --filter @voice-agent/web e2e:billing` -> `e2e/billing-run.mjs` -> `playwright test --config playwright.billing.config.ts` (`billing.e2e.ts`, 8 tests) | same job server, DB `voice_agent_billing_ui_test`, role `voice_app_billuitest`; API :4291, web :3291 (`next build` + `next start` on a temp copy); runs after the security suite, never concurrently | COVERED (was already wired; this review gave it its own log dir and made it run even if the security suite fails) |
| API typecheck | Security / `api`; CI / `api` | `pnpm --filter @voice-agent/api typecheck` | none | COVERED |
| API lint | Security / `api`; CI / `api` | `pnpm --filter @voice-agent/api lint` | none | COVERED |
| API build | Security / `api` (added this review, last step); CI / `api` | `pnpm --filter @voice-agent/api build` (`tsc -p tsconfig.json`) | none | COVERED (previously only in ci.yml) |
| Web typecheck / lint / build | Security / `web`; CI / `web` | `pnpm --filter @voice-agent/web typecheck`, `lint`, `build` | none | COVERED |
| Schema drift: `drizzle-kit check` | Security / `api` / "Migration drift check" | `pnpm exec drizzle-kit check` (in `apps/api`) | none (config needs `DATABASE_URL`, does not connect) | COVERED |
| Schema drift: generate no-diff | same step | `pnpm exec drizzle-kit generate --name ci_drift_probe`, fail if `git status --porcelain -- src/db/migrations` is non-empty | none | COVERED (requires migrations to be committed; untracked migrations would show as drift) |
| Dependency audit, prod gate | Security / `audit` / "Production dependencies (gate)" | `pnpm audit --prod` | none (needs npm registry) | COVERED |
| Dependency audit, full report | Security / `audit` / "All dependencies (report only)" | `pnpm audit` with `continue-on-error: true` | none | COVERED (report only by design; known dev-only `braces` advisory, `docs/security/dev-dependencies.md`) |
| Frozen lockfile | every job | `pnpm install --frozen-lockfile` | none | COVERED |
| Docker images | CI / `docker` | `docker build -f infra/docker/{api,web}.Dockerfile` | none | COVERED (ci.yml only) |

## Changes made in this review (`.github/workflows/security.yml` only)

1. `api` job: added `pnpm --filter @voice-agent/api build` as the last step (after the drift probe, so the probe sees an
   untouched tree); job name now ends "..., migration drift, build)".
2. `e2e` job (renamed "Browser e2e (Playwright, account security and billing UI)"):
   - `E2E_LOG_DIR` is per suite (`e2e-logs/security`, `e2e-logs/billing`). Before, both runners wrote `web.log` into
     one directory and the billing run truncated the security run's log.
   - New step moves `apps/web/test-results` to `e2e-logs/security/test-results` after the security suite, because
     Playwright empties that folder when the billing run starts (failure screenshots were lost).
   - The billing step runs with `if: !cancelled() && steps.pw.outcome == 'success'`, so a security-suite failure no
     longer hides the billing result. The job still fails if either suite fails.
   - Comment documents the per-suite database, role and ports. The two suites stay serial in one job; no DB is shared.
3. No new jobs, no secrets, actions still pinned by major tag (`checkout@v4`, `pnpm/action-setup@v4`,
   `setup-node@v4`, `upload-artifact@v4`).

Local checks after the change: both workflow files parse (js-yaml 4.3.2);
`pnpm install --frozen-lockfile --lockfile-only` exits 0 ("Lockfile passes supply-chain policies");
journal has 22 entries ending at `0022_billing_grants_hardening`. Not run here: the API suite, Playwright, builds
(the final regression is run separately).

## ci.yml vs security.yml

| Topic | Finding | Action |
|---|---|---|
| Duplicate work | `ci.yml` `api` (typecheck, lint, full test, build) and `web` (typecheck, lint, build) are a subset of Security `api`/`web`. Every PR runs the API suite twice. | Documented only (instruction: do not delete ci.yml jobs). Candidate cleanup after Security is required: drop ci.yml `api`/`web` or make `docker` depend on Security. |
| DB conflicts | None. Each job has its own service container on its own runner; ci.yml uses DB `voice_agent_mvp`, Security uses `voice_agent_ci`; both tests then use their own server's `voice_agent_test`. | none |
| Concurrency groups | `ci-<ref>` and `security-<ref>` are distinct, so neither cancels the other. | none |
| Coverage only in ci.yml | Docker image builds. | Keep ci.yml. |
| Coverage only in security.yml | Migrations twice + count, named RLS/guardrail/billing steps, drift, audits, both Playwright suites. | Make "Security" the required check. |
| Permissions | ci.yml has no `permissions:` block (inherits repo default token scope); Security sets `contents: read`. | Recommend adding `permissions: contents: read` to ci.yml (not changed here). |

## Remaining gaps

* **GitHub CI NOT RUN.** No run URL, no SHA, no job conclusions exist.
* The working tree is uncommitted: `security.yml`, migrations 0012-0022 and snapshots, `apps/web/e2e/`,
  `playwright*.config.ts`, `apps/api/src/scripts/*e2e-setup.ts` must all be committed or the drift check and e2e job fail.
* ~~No upgrade test that starts at exactly 0021~~ **Closed in the integration pass:** `billing-migration.test.ts` now has
  "upgrade from 0021 with billing data applies only 0022 and leaves the data untouched" (own disposable database),
  which runs in the existing "Billing suites" step and the full suite. No workflow change was needed.
* Web typecheck on a clean checkout: `apps/web` `typecheck` is now `next typegen && tsc --noEmit`, so it no longer
  depends on `.next/types` produced by an earlier build (working-tree review P1). Locally `tsc` did not fail without
  `.next` (`skipLibCheck`), but the order-independence is now explicit.
* Steps not provable locally: `docker run --network host ... psql` count check, `playwright install --with-deps`,
  `pnpm audit` registry access, `next build` inside the billing runner on a Linux runner.
* Actions pinned by major tag, not SHA.
* Not covered in CI by design: real Exotel, Sarvam, managed PostgreSQL, alert delivery (see the staging plan).

## GitHub execution (owner actions)

1. Commit all release-candidate files (review `git status`; never `.env`, `.env.*.local`, dumps or test artifacts).
2. Push a branch: `git push -u origin <branch>` (push to a non-default branch alone does not start Security).
3. Open a pull request to the default branch (`master`/`main`); this starts "Security" and "CI".
4. Read each Security job: `api` (`journal entries=22 applied=22`, named RLS/guardrails/billing steps, full suite,
   drift check, build), `web`, `audit` (prod gate green; full report may warn), `e2e` (security suite, billing suite;
   on failure download `e2e-diagnostics`).
5. Record run URL (`https://github.com/monisha840/voice_agent_saas/actions/runs/<id>`), commit SHA, date and each job
   conclusion in `docs/security/ci.md`. Queued, cancelled or skipped is not a pass.
6. After one green run, make "Security" (all four jobs) a required status check in branch protection.
