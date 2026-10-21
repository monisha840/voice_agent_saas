# CI coverage matrix (release candidate; matrix written 2026-10-14, workflow audit and first-run procedure 2026-10-21)

**GitHub CI NOT RUN** (as of 2026-10-21). `gh` is not installed on this machine, so no workflow has executed on
GitHub. Every "COVERED" below means "a step exists in the workflow file that runs this check", not "it passed on
GitHub". Only a run URL of an observed, completed run may be recorded as a pass (see
[How to get CI green the first time](#how-to-get-ci-green-the-first-time) and `docs/security/ci.md`).

The workflow files, the e2e runners, the Playwright configs and migrations 0000-0024 **are committed** (`0432360`,
"Customer dashboard, agent builder with knowledge base, and number management"); the earlier "nothing is committed"
precondition in this file no longer applies. What is still uncommitted is whatever is in the current working tree.

Workflows: `.github/workflows/security.yml` ("Security", jobs `api`, `web`, `audit`, `e2e`) and
`.github/workflows/ci.yml` ("CI", jobs `api`, `web`, `docker`). Both trigger on `pull_request`, on push to
`master`/`main`, and both now have `workflow_dispatch`. Both parse with js-yaml 4.3.2.

## Matrix

Postgres is always a `postgres:16-alpine` service container private to its job (one runner VM per job, so port 5432 in
two jobs is two different servers). Throwaway credentials `postgres/postgres`; no `secrets.*` anywhere.

| Requirement | Workflow / job / step | Command | DB / ports | Status |
|---|---|---|---|---|
| Full API tests with PostgreSQL, as restricted role | Security / `api` / `pnpm --filter @voice-agent/api test` | `vitest run` (global setup creates `voice_agent_test`, migrates it as owner, gives role `voice_app` a login; `src/test/setup.ts` points `DATABASE_URL` at `voice_app`, so RLS is enforced) | job-private server :5432; DBs `voice_agent_ci` (owner URL), `voice_agent_test` (tests); files serial (`fileParallelism: false`) | COVERED |
| Migration: fresh install | Security / `api` / "Migrations apply to an empty database, twice" (first `db:migrate`) | `pnpm --filter @voice-agent/api db:migrate` | `voice_agent_ci` on job :5432 | COVERED |
| Migration: run twice + count | same step | second `db:migrate`, then the journal entry count must equal `select count(*) from drizzle.__drizzle_migrations` via `docker run --network host ... psql`. **The expected number is read from `meta/_journal.json` at run time and is never hard-coded here**, so adding a migration cannot make this row stale; the log prints `journal entries=<n> applied=<n>`. To see the current number locally: `node -e 'console.log(JSON.parse(require("fs").readFileSync("apps/api/src/db/migrations/meta/_journal.json","utf8")).entries.length)'` | `voice_agent_ci` | COVERED |
| Migration: upgrade path | Security / `api` / "RLS, guardrails and migration safety suites" and "Billing suites" (also in full run) | `vitest run src/db/migration-upgrade.test.ts` (upgrade from 0011 with data, catalog equals clean install, re-run is a no-op, 0012 rollback) and `src/modules/billing/billing-migration.test.ts` (upgrade from 0018 with data through 0019-0022, 0022 as runtime role, rollback + re-apply) | per-process `voice_agent_upgrade_test_<pid>` etc. on job :5432 | COVERED (no dedicated 0021->0022-only test; 0022 is exercised in the 0018 upgrade, see gaps) |
| RLS tests | Security / `api` / named step | `vitest run src/db/rls.test.ts` (+ `migrate-guard.test.ts`) | `voice_agent_test` as `voice_app` | COVERED |
| Guardrails | Security / `api` / named step | `vitest run src/security/guardrails.test.ts` (tenant tables have RLS, tenant-addressed repos, route auth) | `voice_agent_test` | COVERED |
| Billing regression tests | Security / `api` / "Billing suites" (also in full run) | `vitest run src/modules/billing` (6 test files: `billing-audit`, `billing-migration`, `billing-pure`, `billing-security`, `billing-ws1`, `billing`) | `voice_agent_test` + disposable billing migration DBs | COVERED |
| Security Playwright e2e | Security / `e2e` / "Account security e2e (both MFA phases)" | `pnpm --filter @voice-agent/web e2e` -> `e2e/run.mjs` -> `playwright test` (`playwright.config.ts`, `*.spec.ts`), phases `off,enforce` | job-private server :5432, DB `voice_agent_ui_test`, role `voice_app_uitest`; API :4100, web :3100 (`next dev` on a temp copy) | COVERED |
| Billing Playwright e2e | Security / `e2e` / "Billing UI e2e (production web build)" | `pnpm --filter @voice-agent/web e2e:billing` -> `e2e/billing-run.mjs` -> `playwright test --config playwright.billing.config.ts` (`billing.e2e.ts`, 8 tests) | same job server, DB `voice_agent_billing_ui_test`, role `voice_app_billuitest`; API :4291, web :3291 (`next build` + `next start` on a temp copy); runs after the security suite, never concurrently | COVERED (was already wired; this review gave it its own log dir and made it run even if the security suite fails) |
| Customer dashboard Playwright e2e | Security / `e2e` / "Customer dashboard e2e (production web build)" | `pnpm --filter @voice-agent/web e2e:dashboard` -> `e2e/dashboard-run.mjs` -> `playwright test --config playwright.dashboard.config.ts` (`dashboard.e2e.ts`) | same job server, DB `voice_agent_dashboard_ui_test`, role `voice_app_dashuitest`; API :4391, web :3391 (`next build` + `next start` on a temp copy) | COVERED |
| Knowledge base / playground Playwright e2e | Security / `e2e` / "Knowledge base and playground e2e (production web build)" | `pnpm --filter @voice-agent/web e2e:knowledge` -> `e2e/knowledge-run.mjs` -> `playwright test --config playwright.knowledge.config.ts` (`knowledge.e2e.ts`) | same job server, DB `voice_agent_kb_ui_test`, role `voice_app_kbuitest`; API :4491, web :3491 (`next build` + `next start` on a temp copy) | COVERED |
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

## Changes made in the 2026-10-14 review (`.github/workflows/security.yml` only)

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
`pnpm install --frozen-lockfile --lockfile-only` exits 0 ("Lockfile passes supply-chain policies").
Not run here: the API suite, Playwright, builds (the final regression is run separately).

## Changes made in the 2026-10-21 workflow audit (both workflow files)

Goal: remove every reason a first GitHub run would fail or not trigger. No app code and no `package.json` was
touched.

| # | Problem | Fix |
|---|---|---|
| 1 | Database hosts were written as `localhost`. Node may resolve `localhost` to `::1`, and a service container's mapped port only answers on IPv4 - the exact trap `apps/web/.env.example` warns about. Would have surfaced as a connection refused in the test, migration or e2e job. | All four DB URLs and the `psql -h` flag now use `127.0.0.1`: `DATABASE_URL` (both workflows), `DATABASE_MIGRATION_URL`, `E2E_ADMIN_URL`, and the count-check `psql`. |
| 2 | `timeout-minutes` too small for a 2-core runner. Security `api` had 25 min for a serial ~1900-test suite that takes ~8.6 min on a dev machine, plus the named subsets, two migration runs, the drift probe and a build; `e2e` had 30 min for four suites with three `next build`s. A timeout is a cancelled job, which is not a pass. | Security `api` 25 -> 60, `e2e` 30 -> 60, `web` 20 -> 30, `audit` 10 -> 15. CI `api` 60, `web` 30, `docker` 30 (had none at all - a hung job could have run for GitHub's 6-hour default). Deliberately generous; tighten after the first run shows real durations. |
| 3 | `ci.yml` had no `permissions:` block, so its token inherited the repository default scope. (Previously only recommended here.) | `permissions: contents: read`, matching security.yml. |
| 4 | `ci.yml` had no `workflow_dispatch`, so it could not be started by hand even after reaching the default branch. | Added. |
| 5 | Nothing in either file said that a push to a feature branch starts nothing. | Both files open with a "WHEN THIS RUNS" comment naming `master` as the default branch and pointing here. |
| 6 | The `docker` job built the images with the Dockerfiles' own default `NODE_VERSION`/`PNPM_VERSION` args, so the pin existed in two places and could drift. | The job passes `--build-arg NODE_VERSION`/`PNPM_VERSION` from the workflow `env`. The Dockerfile defaults already matched (22 / 12.6.0). |
| 7 | Step name said "migrations 0019-0022", stale as soon as a migration is added. | Renamed to "billing migration upgrade paths". A comment also states the count check reads the journal at run time and is never hard-coded. |
| 8 | The `e2e` job name still said "account security and billing UI" although it runs four suites. | Renamed to "account security, billing, dashboard and knowledge base UI"; the dashboard and knowledge suites are now in the matrix above. |

Verified locally on 2026-10-21, without pushing:

* Both files parse (js-yaml 4.3.2) and every job now declares `timeout-minutes`; no `needs:` names a missing job;
  `steps.pw.outcome` references a real step id.
* Every `pnpm --filter <pkg> <script>` in both files resolves to a script that exists: api `typecheck`, `lint`,
  `test`, `build`, `db:migrate`; web `typecheck`, `lint`, `build`, `e2e`, `e2e:billing`, `e2e:dashboard`,
  `e2e:knowledge`. Every path referenced exists: both Dockerfiles, `meta/_journal.json`, the four named vitest
  files, `src/modules/billing`, and the four `playwright.*.config.ts` files the runners load.
* **pnpm 12.6.0 is real and is the right pin.** `npm view pnpm dist-tags` reports `latest: 12.14.0`, and 12.6.0 is
  in `npm view pnpm versions`. The machine that wrote `pnpm-lock.yaml` ran that exact version:
  `node_modules/.modules.yaml` records `"packageManager": "pnpm@12.6.0"`, and `pnpm -v` prints `12.6.0`. The
  lockfile is `lockfileVersion: '9.0'`, which is what pnpm 12 writes, so `--frozen-lockfile` has nothing to
  upgrade. There is no `packageManager` field in `package.json`, so the `version:` input of
  `pnpm/action-setup@v4` is the only pin and cannot conflict with one.
* **Node 22 is a valid pin.** `engines.node` is `>=20.0.0`; the code's newest Node requirement found is
  `import.meta.dirname` (Node >= 20.11). The dev machine runs Node 24.15.0, which is the one version skew left:
  nothing in the repo pins a Node version for local use, so a failure that only reproduces on 22 is possible in
  principle. Reporting, not fixing, because `package.json` is owned elsewhere - see "Recommended, not done".
* The lockfile is cross-platform complete, so a Windows-generated lockfile installing on Linux is not a risk:
  `@next/swc-linux-x64-gnu`, `@unrs/resolver-binding-linux-x64-gnu`, `@esbuild/linux-x64` and
  `lightningcss-linux-x64-gnu` are all present.
* `pnpm audit --prod` (the gate in the `audit` job): "No known vulnerabilities found".
* `pnpm exec drizzle-kit check` in `apps/api`: "Everything's fine".
* The workflow files, `apps/web/e2e/*`, every `playwright.*.config.ts` and all migration artefacts are tracked by
  git (`git ls-files`), so the e2e job will find its runners and the drift probe will not see them as drift.

## Recommended, not done (owned by other files/agents)

* Add `"packageManager": "pnpm@12.6.0"` to the root `package.json` and a `.nvmrc`/`engines` note for Node, so a
  local machine cannot silently use a different toolchain than CI. `package.json` is owned by another agent.
* Consider dropping `ci.yml`'s `api`/`web` jobs (or making `docker` depend on Security) once "Security" is the
  required check: today every pull request runs the full API suite twice, which doubles the slowest job and gives
  flakes two chances to fire.
* Pin the actions by commit SHA instead of major tag.

## ci.yml vs security.yml

| Topic | Finding | Action |
|---|---|---|
| Duplicate work | `ci.yml` `api` (typecheck, lint, full test, build) and `web` (typecheck, lint, build) are a subset of Security `api`/`web`. Every PR runs the API suite twice. | Documented only (instruction: do not delete ci.yml jobs). Candidate cleanup after Security is required: drop ci.yml `api`/`web` or make `docker` depend on Security. |
| DB conflicts | None. Each job has its own service container on its own runner; ci.yml uses DB `voice_agent_mvp`, Security uses `voice_agent_ci`; both tests then use their own server's `voice_agent_test`. | none |
| Concurrency groups | `ci-<ref>` and `security-<ref>` are distinct, so neither cancels the other. | none |
| Coverage only in ci.yml | Docker image builds. | Keep ci.yml. |
| Coverage only in security.yml | Migrations twice + count, named RLS/guardrail/billing steps, drift, audits, all four Playwright suites. | Make "Security" the required check. |
| Permissions | Both now set `permissions: contents: read`. | Done 2026-10-21. |
| Triggers | Identical: push to `master`/`main`, any `pull_request`, `workflow_dispatch`. Neither reacts to a push to a feature branch. | Done 2026-10-21 (ci.yml gained `workflow_dispatch`). |

## Remaining gaps

* **GitHub CI NOT RUN** (2026-10-21). No run URL, no SHA, no job conclusions exist.
* ~~The working tree is uncommitted~~ **Closed:** the workflows, `apps/web/e2e/`, `playwright*.config.ts` and
  migrations 0000-0024 were committed in `0432360`. The standing requirement is narrower now: whatever migration
  artefacts the current branch adds (`<n>.sql`, `meta/<n>_snapshot.json`, `meta/_journal.json`) must be committed
  together with the `schema.ts` change, or the drift probe fails.
* ~~No upgrade test that starts at exactly 0021~~ **Closed in the integration pass:** `billing-migration.test.ts` now has
  "upgrade from 0021 with billing data applies only 0022 and leaves the data untouched" (own disposable database),
  which runs in the existing "Billing suites" step and the full suite. No workflow change was needed.
* Web typecheck on a clean checkout: `apps/web` `typecheck` is now `next typegen && tsc --noEmit`, so it no longer
  depends on `.next/types` produced by an earlier build (working-tree review P1). Locally `tsc` did not fail without
  `.next` (`skipLibCheck`), but the order-independence is now explicit.
* Steps that cannot be proved on this machine at all, and so are still unknown: the GitHub runner itself, the
  `postgres:16-alpine` service container, `docker run --network host ... psql` for the count check,
  `playwright install --with-deps`, `pnpm audit` registry access from a runner, `docker build` of both images,
  and `next build` inside the four e2e runners on Linux (`prod-suite.mjs` symlinks `node_modules` with
  `type: "junction"`, which Node ignores on POSIX and turns into an absolute symlink - read as safe, not run).
* Actions pinned by major tag, not SHA.
* The dev machine runs Node 24 while CI pins Node 22; nothing in the repo pins Node locally.
* `pnpm audit --prod` is a gate against a live advisory database, so a new advisory in a production dependency can
  turn a previously green pipeline red without any code change. It is clean as of 2026-10-21.
* Not covered in CI by design: real Exotel, Sarvam, managed PostgreSQL, alert delivery (see the staging plan).

## How to get CI green the first time

Written 2026-10-21, after auditing both workflow files against the repository. Everything below is an owner action;
no agent commits, pushes or opens pull requests.

**The one thing that stops a run before anything else: the branch.** Both workflows' `push` trigger is
`[master, main]` only. The working branch is `fix/turn-deadline-and-voice-metrics`, so
`git push -u origin fix/turn-deadline-and-voice-metrics` **starts nothing at all** - no run, no failure, no e-mail.
`workflow_dispatch` will not help either: GitHub only lists a workflow for manual runs when its file exists on the
default branch (`master`), and the version it runs is the one on `master`. So the first run must come from either a
pull request into `master` or a push/merge to `master` itself. A pull request is the right choice: it runs the
workflow files from the PR's merge commit, so you test the versions you are about to merge.

1. **Check what you are about to commit.** `git status`. Never commit `.env`, `.env.*.local`, database dumps, test
   artefacts, or the `_tmp-*` scratch scripts under `apps/api/src/scripts/`.
2. **Commit migration artefacts as a set.** If the branch adds a migration, `schema.ts`, the new `<n>.sql`,
   `meta/<n>_snapshot.json` and `meta/_journal.json` must all be in the same commit. The drift probe runs
   `drizzle-kit generate` on a clean checkout and fails if that produces anything, so a missing snapshot or a
   `schema.ts` change without its migration is a red job.
3. **Sanity-check locally first** (minutes, and it saves a round trip):
   `pnpm --filter @voice-agent/api typecheck`, `pnpm --filter @voice-agent/api lint`,
   `pnpm --filter @voice-agent/web typecheck`, `pnpm --filter @voice-agent/web lint`,
   `cd apps/api && pnpm exec drizzle-kit check`, and `pnpm audit --prod`. All five were green here on 2026-10-21.
4. **Push the branch**, then **open a pull request into `master`**. This is the step that actually starts "CI" and
   "Security". Do not force-push while the run is in flight: both workflows use `cancel-in-progress: true`, and a
   cancelled run is not a pass.
5. **Watch these four Security jobs**, in this order:
   * `API (typecheck, lint, tests as restricted role, migration drift, build)` - in the step "Migrations apply to an
     empty database, twice", the log line `journal entries=<n> applied=<n>` must show two equal numbers. The
     number itself changes with every migration; do not compare it to a number written in a document, compare the
     two halves of that line to each other.
   * `Web (typecheck, lint, build)`.
   * `Dependency audit` - "Production dependencies (gate)" must be green; "All dependencies" is report-only and is
     allowed to warn (see `docs/security/dev-dependencies.md`).
   * `Browser e2e (Playwright, account security, billing, dashboard and knowledge base UI)` - four suites run
     serially; on failure download the `e2e-diagnostics` artefact (per-suite `e2e-logs/*`, screenshots, 7 days).
6. **Also watch the "CI" workflow's `docker` job.** It only runs after CI's `api` and `web` pass, and it is the only
   place the images are built.
7. **If a job is red, read it as a signal about the code, not the workflow** - every script, path, filter name and
   version in both files was verified against the repository on 2026-10-21. The most likely genuine causes, in
   order: a test that only passes on Node 24, a timing-sensitive test on a slower 2-core runner, a `next build`
   that needs more memory than a runner has, or a new dependency advisory in `pnpm audit --prod`.
8. **Record the real result** in `docs/security/ci.md`: the run URL
   (`https://github.com/monisha840/voice_agent_saas/actions/runs/<id>`), the commit SHA, the date, each job's
   conclusion and each job's duration. Only an observed, completed run counts; queued, cancelled and skipped are
   not passes. The durations are what let the generous `timeout-minutes` ceilings be tightened.
9. **After one green run**, make "Security" (all four jobs) a required status check in branch protection for
   `master`.
