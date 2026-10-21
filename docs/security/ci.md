# CI review (2026-10-14; audited again and corrected 2026-10-21)

Workflows: `.github/workflows/ci.yml` (api, web, docker) and `.github/workflows/security.yml` (api, web, audit,
e2e). Both trigger on push to `master`/`main`, on any `pull_request`, and (since 2026-10-21) both have
`workflow_dispatch`. Both YAML files parse with js-yaml 4.3.2.

**Still no GitHub run has ever happened** (checked 2026-10-21). The first-run procedure lives in
`docs/release/ci-coverage.md`, section "How to get CI green the first time"; the single most common reason for
"nothing happened" is that a push to a feature branch matches no trigger. The default branch is `master`.

## No production credentials

* No `secrets.*` reference anywhere; `permissions: contents: read` in **both** workflows (added to ci.yml on
  2026-10-21).
* Every database is a `postgres:16-alpine` service container with throwaway `postgres/postgres` credentials.
* `AI_PROVIDER=mock`, `TELEPHONY_PROVIDER=mock`; no real provider key is set. A throwaway `METRICS_TOKEN` is
  generated per run (`openssl rand`, masked with `::add-mask::`).
* The Playwright job uses `E2E_ADMIN_URL` against its own service Postgres; each runner creates and drops only its
  own database and role (`voice_agent_ui_test`/`voice_app_uitest`, `..._billing_ui_test`/`voice_app_billuitest`,
  `..._dashboard_ui_test`/`voice_app_dashuitest`, `..._kb_ui_test`/`voice_app_kbuitest`) and pins every database
  variable.
* Every database host in both workflows is `127.0.0.1`, not `localhost` (changed 2026-10-21): Node can resolve
  `localhost` to `::1`, which a service container's mapped port does not answer.

## What security.yml runs

| Job | Steps |
|---|---|
| api | frozen-lockfile install, typecheck, lint, **migrations twice on an empty DB plus journal/applied count check** (`DATABASE_URL` and `DATABASE_MIGRATION_URL` name the same DB, so the new guard passes), **named RLS / guardrails / migration-safety vitest run** (`rls.test.ts`, `guardrails.test.ts`, `migration-upgrade.test.ts`, `migrate-guard.test.ts`), **named billing suites** (`src/modules/billing`), full `vitest run` (restricted role `voice_app`), drift check (`drizzle-kit check` and `generate`, fails on any change under `src/db/migrations`), **`api build`** (added in the 2026-10-14 RC review) |
| web | frozen-lockfile install, typecheck, lint, build |
| audit | `pnpm audit --prod` (gate), `pnpm audit` (report only) |
| e2e | Playwright chromium install, then four suites **serially**: `e2e` (both MFA phases; DB `voice_agent_ui_test`, ports 4100/3100, `next dev`), `e2e:billing` (DB `voice_agent_billing_ui_test`, ports 4291/3291), `e2e:dashboard` (DB `voice_agent_dashboard_ui_test`, ports 4391/3391), `e2e:knowledge` (DB `voice_agent_kb_ui_test`, ports 4491/3491) - the last three do a production `next build` first and each runs even if an earlier suite failed. Per-suite log dirs `e2e-logs/{security,billing,dashboard,knowledge}`, diagnostics artifact on failure |

`ci.yml` duplicates api/web and adds docker image builds; it uses a superuser `DATABASE_URL`, which is fine
because the test setup builds its own database and role.

## Local equivalents (this machine, scratch DBs)

* `pnpm install --frozen-lockfile --offline --lockfile-only`: passes ("Lockfile passes supply-chain policies");
  `--frozen-lockfile --offline --dry-run`: "pnpm-lock.yaml is up to date".
* `pnpm --filter @voice-agent/api typecheck`: pass. eslint on the files changed here: pass.
  `pnpm --filter @voice-agent/web typecheck`: pass. `pnpm audit --prod`: "No known vulnerabilities found".
* Migrations: clean install through the 0016 gap and re-run: pass (migration-reconciliation.md section 1).
* Drift: `drizzle-kit check` "Everything's fine"; `drizzle-kit generate` "No schema changes, nothing to migrate"
  (scratch copy; the repo was not touched).
* RLS and migration suites: 40 tests passed.
* Not run locally: the full api suite (other agents are editing billing/monitoring tests), web lint/build,
  Playwright e2e, docker builds.

## GitHub execution: UNVERIFIED (GitHub CI NOT RUN)

`gh` is not installed on this machine, so authentication, repo access and run status could not be checked and
nothing was triggered. Manual steps: commit and push the workflow (owner action), open a PR or merge to the default
branch, then Actions -> Security -> "Run workflow" (requires the file on the default branch). Expected: four green
jobs. Watch for the `docker run ... postgres:16-alpine psql` step (uses `--network host`, valid on
ubuntu-latest) and for `pnpm audit --prod`, which needs registry network access.

## Discrepancies and risks

* 0016 gap (benign, see migration-reconciliation.md).
* ~~Dev database is behind head (0019 hash, missing RLS on billing tables, 0020/0021 pending).~~ **Stale as of
  2026-10-21:** 0022-0024 were committed in `0432360` and applied to dev; only the deliberate 0019 stored-hash
  discrepancy remains. CI never touches dev, so this was never a CI risk - check the real state with
  `select count(*), max(created_at) from drizzle.__drizzle_migrations;`.
* `actions/*` are tag-pinned, not SHA-pinned; pnpm 12.6.0 is pinned and equals the local version (verified again
  2026-10-21: `node_modules/.modules.yaml` records `pnpm@12.6.0`, `pnpm -v` prints 12.6.0, and
  `npm view pnpm dist-tags` reports `latest: 12.14.0`, so 12.6.0 is a real published version).
* security.yml previously ran on pull_request only, so a direct push to master was not covered; fixed.
* ci.yml has no drift, audit or e2e; the Security workflow should be the required check.

## Review 2 (2026-10-14): verified facts, defects, and how to run it on GitHub

### Checked against the repository

| Item | Result |
|---|---|
| Scripts the workflow calls exist | `typecheck`, `lint`, `db:migrate`, `test` in `apps/api/package.json`; `typecheck`, `lint`, `build`, `e2e` in `apps/web/package.json`; the four named vitest files and `apps/web/e2e/run.mjs`, `apps/api/src/scripts/ui-e2e-setup.ts` exist |
| Versions | workflow Node 22, pnpm 12.6.0; root `engines.node >=20`; there is no `packageManager` field, so `pnpm/action-setup` `version:` is the only pin (no conflict possible). Local machine: Node 24.15.0, pnpm 12.6.0 |
| drizzle-kit | `drizzle.config.ts` throws without `DATABASE_URL`; the job sets it. `check` and `generate` do not connect to the database |
| Postgres service | `postgres:16-alpine`, `postgres/postgres`, health-checked, port 5432; migration step sets both `DATABASE_URL` and `DATABASE_MIGRATION_URL` to the same database (guard satisfied) |
| e2e ports | `e2e/run.mjs` uses fixed API 4100 and web 3100 and aborts if either is taken; the job runs alone on a fresh runner, so no conflict. Locally, stop anything on 3100/4100 first |
| YAML | `security.yml`, `ci.yml`, `alert-rules.yml` parse with js-yaml 4.3.2 |

No workflow defect that could be proven locally was found **in that review**, so no workflow change was made then.
Review 3 (2026-10-21, below) did find and fix several.

~~**The working tree is not committed.**~~ **Closed 2026-10-21:** the workflows, migrations 0012-0024 with their
snapshots, `apps/web/e2e/`, the Playwright configs and `docs/security/` are all committed (`7f9cd53`, `0432360`)
and tracked (`git ls-files`). The underlying rule still holds for every future branch: a branch that omits a
generated migration artefact fails the drift check, and one that omits an e2e runner fails the e2e job.
Remote `origin` is `https://github.com/monisha840/voice_agent_saas`; the default branch is `master`.

### Procedure to execute the Security workflow on GitHub (owner actions)

1. Review `git status` and commit the branch's own changes - in particular, a new migration's `.sql`,
   `meta/<n>_snapshot.json` and `meta/_journal.json` must go in together with the `schema.ts` change. Do not add
   `.env`, `.env.pre-rls.local`, `apps/api/src/scripts/_tmp-*` or any file containing credentials.
2. Push a branch: `git push -u origin <branch>`. A push to a non-default branch does NOT start Security (its `push`
   trigger is master/main only).
3. Start a run, either:
   - open a pull request from the branch into `master`/`main` (the `pull_request` trigger starts "Security" and
     "CI"; the workflow file from the PR merge commit is used), or
   - Actions tab -> "Security" -> "Run workflow" -> pick the branch. `workflow_dispatch` only lists a workflow
     once its file exists on the default branch, so for the very first run use the pull request.
4. Open the run (Actions -> Security -> the run). Read, in this order:
   - the four job names: "API (typecheck, lint, tests as restricted role, migration drift, build)", "Web (typecheck,
     lint, build)", "Dependency audit", "Browser e2e (Playwright, account security, billing, dashboard and knowledge
     base UI)" (names changed in the 2026-10-14 and 2026-10-21 reviews; see `docs/release/ci-coverage.md`);
   - API job step "Migrations apply ... twice": the log line `journal entries=<n> applied=<n>` must show two equal
     numbers. The value changes with every migration, so compare the two halves of the line to each other and never
     to a number copied from a document;
   - API job step "Migration drift check": on failure it prints `::error::schema.ts differs ...` and the changed files;
   - Audit job: "Production dependencies (gate)" must be green; "All dependencies" is report-only (allowed to warn);
   - e2e job: the four suite steps ("Account security e2e (both MFA phases)", "Billing UI e2e", "Customer dashboard
     e2e", "Knowledge base and playground e2e") must all be green; on failure download the `e2e-diagnostics`
     artifact (`e2e-logs/{security,billing,dashboard,knowledge}`, screenshots, 7 days).
5. Record the real result in the table below: the run URL
   (`https://github.com/monisha840/voice_agent_saas/actions/runs/<id>`), the commit SHA it ran on, the date, and
   each job's conclusion **and duration**. Only a URL of an observed run may be recorded as "passed"; a queued,
   cancelled or skipped job is not a pass. The durations are what justify lowering the `timeout-minutes` ceilings
   that were raised on 2026-10-21.
6. Make "Security" a required status check in the branch protection rules after one green run.

### Verified locally vs not

| Check | Local evidence (2026-10-14) | GitHub |
|---|---|---|
| API typecheck (`pnpm --filter @voice-agent/api typecheck`) | exit 0 | UNVERIFIED |
| API lint (`eslint src --ext .ts`) | runtime files clean; whole-repo run reports warnings in other agents' files, see report | UNVERIFIED |
| Web typecheck | exit 0 | UNVERIFIED |
| `pnpm audit --prod` | "No known vulnerabilities found" | UNVERIFIED (needs registry access) |
| `drizzle-kit check` | "Everything's fine" | UNVERIFIED |
| `drizzle-kit generate` (drift) | "No schema changes, nothing to migrate"; no new files appeared | UNVERIFIED |
| Metrics, alert-rule and socket tests | 26 passed (3 files) | UNVERIFIED |
| Migrations twice on empty DB + count check | not re-run in this review (earlier review: pass) | UNVERIFIED |
| Full api vitest, web lint/build, Playwright, docker builds | not run (shared files under edit by other agents) | UNVERIFIED |
| Workflow executes at all (runner, `postgres:16-alpine` service, `docker run --network host`, `playwright install --with-deps`) | not possible locally | **UNVERIFIED: no run observed** |

---

## Review 3 (2026-10-21): workflow audit, defects fixed, first-run blocker named

Both workflow files were read line by line against the repository. Everything they reference exists; the defects
found were environmental and configuration-level, not missing scripts.

### Fixed in the workflow files

| # | Defect | Why it would have cost a run | Fix |
|---|---|---|---|
| 1 | Database hosts written as `localhost` (`DATABASE_URL` in both files, `DATABASE_MIGRATION_URL`, `E2E_ADMIN_URL`, and `psql -h`). | Node may resolve `localhost` to `::1`; a service container's mapped port answers only on IPv4. This is the trap `apps/web/.env.example` warns about in this very repo. It would have looked like a database outage in the test, migration or e2e job. | All now `127.0.0.1`. |
| 2 | `timeout-minutes` set below the realistic runtime: Security `api` 25 min for a serial ~1900-test suite (~8.6 min on a dev machine) plus named subsets, two migration runs, drift probe and build; `e2e` 30 min for four suites with three `next build`s. `ci.yml` had no timeouts at all. | A timeout is a cancelled job, and a cancelled job is not a pass. This was the most likely way for a first run to "fail" without anything being wrong. | Security `api` 60, `e2e` 60, `web` 30, `audit` 15; CI `api` 60, `web` 30, `docker` 30. Generous on purpose; tighten once real durations are recorded above. |
| 3 | `ci.yml` had no `permissions:` block. | Its `GITHUB_TOKEN` inherited the repository default scope, which can be write. | `permissions: contents: read`. |
| 4 | `ci.yml` had no `workflow_dispatch`. | Could not be started by hand even once on the default branch. | Added. |
| 5 | Neither file said which pushes it reacts to. | The owner's branch is not `master`, so pushing it starts nothing - silently. | A "WHEN THIS RUNS" comment at the top of both files, naming `master` and pointing at `docs/release/ci-coverage.md`. |
| 6 | The `docker` job let the Dockerfiles pick their own `NODE_VERSION`/`PNPM_VERSION` defaults. | Two places to keep in sync. | The job passes both as `--build-arg` from the workflow `env` (the Dockerfile defaults already matched). |
| 7 | Stale step/job names: "migrations 0019-0022", "account security and billing UI". | Misleading logs, and stale again on the next migration. | Renamed; the migration count check is documented as reading the journal at run time. |

### Verified locally, without pushing

* Both files parse (js-yaml 4.3.2); every job declares `timeout-minutes`; `needs:` names only real jobs;
  `steps.pw.outcome` refers to a real step id.
* Every `pnpm --filter <pkg> <script>` resolves: api `typecheck`, `lint`, `test`, `build`, `db:migrate`; web
  `typecheck`, `lint`, `build`, `e2e`, `e2e:billing`, `e2e:dashboard`, `e2e:knowledge`. Every referenced path
  exists (both Dockerfiles, `meta/_journal.json`, the four named vitest files, `src/modules/billing`, the four
  `playwright.*.config.ts` the runners load).
* pnpm: `PNPM_VERSION: "12.6.0"` is a real published version (`npm view pnpm dist-tags` -> `latest: 12.14.0`), is
  the version that wrote `pnpm-lock.yaml` (`node_modules/.modules.yaml`: `"packageManager": "pnpm@12.6.0"`), and
  matches `pnpm -v` locally. The lockfile is `lockfileVersion: '9.0'`, which pnpm 12 writes, so `--frozen-lockfile`
  has nothing to migrate. There is no `packageManager` field in `package.json`, so `pnpm/action-setup`'s `version:`
  input cannot conflict with one.
* Node: `NODE_VERSION: "22"` satisfies `engines.node >= 20.0.0`; the newest Node feature the code needs is
  `import.meta.dirname` (>= 20.11). The dev machine runs Node 24.15.0 and nothing in the repo pins Node locally -
  the one remaining toolchain skew, and the most plausible cause of a red job that is green locally.
* The lockfile carries the Linux binaries a Linux runner needs (`@next/swc-linux-x64-gnu`,
  `@unrs/resolver-binding-linux-x64-gnu`, `@esbuild/linux-x64`, `lightningcss-linux-x64-gnu`), so a
  Windows-written lockfile installing on ubuntu is not a risk.
* `pnpm audit --prod` (the gate): "No known vulnerabilities found". `drizzle-kit check` in `apps/api`:
  "Everything's fine".
* The workflows, `apps/web/e2e/*`, every `playwright.*.config.ts` and all migration artefacts are tracked by git.

### Not verifiable without a run

The runner itself, the `postgres:16-alpine` service container, `docker run --network host ... psql`,
`playwright install --with-deps`, `pnpm audit` registry access from a runner, `docker build` of both images, and
`next build` inside the four e2e runners on Linux (`prod-suite.mjs` creates its `node_modules` symlink with
`type: "junction"`, which Node ignores on POSIX - read as safe, not executed). The full vitest suite, the web build
and Playwright were deliberately not run here.

### Recommended but not done (other owners)

* Add `"packageManager": "pnpm@12.6.0"` to the root `package.json`, and pin Node locally (`.nvmrc` or a narrower
  `engines.node`), so a developer machine cannot use a different toolchain than CI. `package.json` is owned
  elsewhere.
* Once "Security" is the required check, consider dropping `ci.yml`'s `api`/`web` jobs: today every pull request
  runs the full API suite twice.
* Pin the actions by commit SHA.

## GitHub execution record (fill in from a real run)

| Date (UTC) | Run URL | Workflow | Commit SHA | api | web | audit | e2e | docker | Durations | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | **no run exists yet as of 2026-10-21** |
