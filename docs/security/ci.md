# CI review (2026-10-14)

Workflows: `.github/workflows/ci.yml` (api, web, docker; push to master/main and PRs) and
`.github/workflows/security.yml` (PR gate; now also push to master/main and manual `workflow_dispatch`).
Both YAML files parse with js-yaml 4.3.2.

## No production credentials

* No `secrets.*` reference anywhere; `permissions: contents: read` in security.yml.
* Every database is a `postgres:16-alpine` service container with throwaway `postgres/postgres` credentials.
* `AI_PROVIDER=mock`, `TELEPHONY_PROVIDER=mock`; no real provider key is set. A throwaway `METRICS_TOKEN` is
  generated per run (`openssl rand`, masked with `::add-mask::`).
* The Playwright job uses `E2E_ADMIN_URL` against its own service Postgres; `e2e/run.mjs` creates and drops only
  `voice_agent_ui_test` and role `voice_app_uitest` and pins every database variable.

## What security.yml runs

| Job | Steps |
|---|---|
| api | frozen-lockfile install, typecheck, lint, **migrations twice on an empty DB plus journal/applied count check** (`DATABASE_URL` and `DATABASE_MIGRATION_URL` name the same DB, so the new guard passes), **named RLS / guardrails / migration-safety vitest run** (`rls.test.ts`, `guardrails.test.ts`, `migration-upgrade.test.ts`, `migrate-guard.test.ts`), **named billing suites** (`src/modules/billing`), full `vitest run` (restricted role `voice_app`), drift check (`drizzle-kit check` and `generate`, fails on any change under `src/db/migrations`), **`api build`** (added in the 2026-10-14 RC review) |
| web | frozen-lockfile install, typecheck, lint, build |
| audit | `pnpm audit --prod` (gate), `pnpm audit` (report only) |
| e2e | Playwright chromium install, `pnpm --filter @voice-agent/web e2e` (both MFA phases; DB `voice_agent_ui_test`, ports 4100/3100), then `pnpm --filter @voice-agent/web e2e:billing` (production web build; DB `voice_agent_billing_ui_test`, ports 4291/3291; runs even if the security suite failed), per-suite log dirs `e2e-logs/{security,billing}`, diagnostics artifact on failure |

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
* Dev database is behind head and differs from it (0019 hash, missing RLS on billing tables, 0020/0021 pending).
* `actions/*` are tag-pinned, not SHA-pinned; pnpm 12.6.0 is pinned and equals the local version.
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

No workflow defect that could be proven locally was found, so no workflow change was made in this review. One
precondition is a real blocker for GitHub, not a workflow bug:

**The working tree is not committed.** `git status` shows 127 modified files and untracked
`.github/workflows/security.yml`, migrations `0012`-`0022` with their snapshots, `apps/web/e2e/`,
`apps/api/src/scripts/ui-e2e-setup.ts`, `apps/api/src/runtime/metrics*.ts` and `docs/security/`. A branch that
omits any of them fails (drift check reports uncommitted migrations as drift; the e2e job cannot find `run.mjs`).
Current branch is `phase5-sarvam-verified`; remote `origin` is `https://github.com/monisha840/voice_agent_saas`.

### Procedure to execute the Security workflow on GitHub (owner actions)

1. Review `git status` and commit every file listed above, including `.github/workflows/security.yml`. Do not add
   `.env`, `.env.pre-rls.local` or any file containing credentials.
2. Push a branch: `git push -u origin <branch>`. A push to a non-default branch does NOT start Security (its `push`
   trigger is master/main only).
3. Start a run, either:
   - open a pull request from the branch into `master`/`main` (the `pull_request` trigger starts "Security" and
     "CI"; the workflow file from the PR merge commit is used), or
   - Actions tab -> "Security" -> "Run workflow" -> pick the branch. `workflow_dispatch` only lists a workflow
     once its file exists on the default branch, so for the very first run use the pull request.
4. Open the run (Actions -> Security -> the run). Read, in this order:
   - the four job names: "API (typecheck, lint, tests as restricted role, migration drift, build)", "Web (typecheck,
     lint, build)", "Dependency audit", "Browser e2e (Playwright, account security and billing UI)" (names changed in
     the 2026-10-14 RC review; see `docs/release/ci-coverage.md`);
   - API job step "Migrations apply ... twice": the log line `journal entries=<n> applied=<n>` must show equal numbers;
   - API job step "Migration drift check": on failure it prints `::error::schema.ts differs ...` and the changed files;
   - Audit job: "Production dependencies (gate)" must be green; "All dependencies" is report-only (allowed to warn);
   - e2e job: steps "Account security e2e (both MFA phases)" and "Billing UI e2e (production web build)" must both be
     green; on failure download the `e2e-diagnostics` artifact (`e2e-logs/security`, `e2e-logs/billing`, screenshots,
     7 days).
5. Record the real result: copy the run URL (`https://github.com/monisha840/voice_agent_saas/actions/runs/<id>`),
   the commit SHA it ran on, the date, and each job's conclusion into this file under "GitHub execution". Only a URL
   of an observed run may be recorded as "passed"; a queued, cancelled or skipped job is not a pass.
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
