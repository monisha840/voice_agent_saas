# Staging readiness report (2026-10-14)

Local verification only. Nothing here was committed, pushed or deployed; no real provider or GitHub run happened.

## 1. Verified state

| Fact | Evidence |
|---|---|
| Dev database has **21** migrations applied; the last is `0021_stream_grants` (`created_at` 1791984931706). 0019, 0020 and 0021 are present; `plans`, `stream_grants`, `billing_cap_for` exist. | read-only `select` on `drizzle.__drizzle_migrations` and `to_regclass` |
| The conflicting "0019" report was stale; the "0021" report is correct. A **22nd** migration, `0022_billing_grants_hardening`, was added to the journal afterwards and is **not applied** to the dev database. | journal has 22 entries (idx 0-15, 17-22; idx 16 is a permanent gap); 21 applied |
| Journal, SQL files and snapshots agree; no drift. | `drizzle-kit check` "Everything's fine"; `drizzle-kit generate` "No schema changes" and wrote nothing (migration file count unchanged) |
| Dev data intact: 1 organization, 1 user, 182 calls, 2 agents; forced RLS on all 23 tenant-owned tables including `subscriptions`, `usage_ledger`, `billing_events`. | same read-only session |
| No migration history was rewritten. | untouched |

The development database was only read.

## 2. Rate-limit identity (implemented)

Design and deployment requirements: `docs/security/rate-limiting.md`, section "Keying strategy: IP, user, organization".

* Added `authenticatedRateLimitHook` (`security/rate-limits.ts`, registered after the login gate in `app.ts`): per verified
  user (`RATE_LIMIT_USER_MAX`, 300/min) and per organization (`RATE_LIMIT_ORG_MAX`, 1500/min). Config in `config/env.ts`.
* The global per-IP budget is unchanged and remains the only budget unauthenticated or forged-cookie requests reach.
* `X-Forwarded-For` is honoured only from peers in `TRUST_PROXY` (existing mechanism); tests prove untrusted peers and
  prepended chain entries cannot choose a bucket.
* **Not done, needs approval:** forwarding the visitor address from Next.js. The public-access guard 404s every request
  carrying `X-Forwarded-*`, so naive forwarding breaks the dashboard (I implemented it, saw the 404s, and reverted it).
  Options are in the rate-limiting doc.
* **Remaining limitation:** one shared server address still shares the per-IP ceiling (300/min) across all users until
  that decision is made or the ceiling is raised for that address.

## 3. Commands and results (this machine, 2026-10-14)

| Command | Result |
|---|---|
| `TEST_DATABASE_NAME=voice_agent_test_billing npx vitest run` (restricted role `voice_app`) | first run: 2 failed / 1855 passed / 13 skipped (143 files). `hardening.test.ts` log redaction failed while `shared/logger.ts` was being edited by another agent (modified 19:52, during the run); `conversation-streaming.test.ts` "first chunk" is a 20 ms timing assertion. Both passed when re-run alone (34 tests). The full suite was **not** re-run end to end after that. |
| New `rate-limit-identity.test.ts` + `rate-limits.test.ts` | 21 passed |
| Security e2e (`node e2e/run.mjs`, ports 4100/3100) | phase off: 6 passed; phase enforce: 1 passed |
| Billing e2e on a production build (`node e2e/billing-run.mjs`, ports 4291/3291) | 8 passed; `next build` compiled successfully |
| API `tsc --noEmit`, web `tsc --noEmit` | clean, clean |
| API `eslint src` / web `next lint` | 0 errors, 13 warnings / clean |
| `pnpm audit --prod` | No known vulnerabilities found |
| `pnpm audit` (all) | 1 high, `braces` (GHSA-vfj7-8cjw-p6xm) via dev-only eslint tooling; no upgrade made (dependency changes are out of scope) |

Not run: docker image builds, any real-provider call, any GitHub workflow.

## 4. Provisioning: security design review (NOT implemented, awaiting approval)

Subject: the proposal in `docs/billing/README.md` (SECURITY DEFINER `app_create_workspace`).

| Aspect | Assessment | Required before approval |
|---|---|---|
| Ownership | Dedicated NOLOGIN role owns the function; it must hold only `INSERT` on the five tables, `SELECT` on `plans`, `SELECT (user_id)` on `memberships`. Not `voice_app`, not the table owner. | Role created by the migration owner, not by the application; document the role in `rls-rollout.md`. |
| `search_path` | Must be pinned (`pg_catalog, public`) like the 0012 lookups, and every object schema-qualified. | Catalog test asserting `proconfig` on the function. |
| Execute grant | `REVOKE ALL FROM PUBLIC`; `GRANT EXECUTE` to `voice_app` only. | Catalog test (as exists for the 0012 lookups). |
| Identity | Caller passes `user_id`; the database cannot verify it is the caller. A compromised runtime could create an empty workspace for another user. Mitigations: one workspace per user, audited, rate limited. | Accept the residual risk explicitly, or bind to `app.user_id` set by the transaction (the function should require `app_current_user() = p_user_id`, which the proposal omitted: add it). |
| Role selection | `OWNER` literal in the function; request body `.strict()` with only `name`. | Test that a body-supplied role/organization is rejected. |
| Atomicity | One function call = one transaction (organization, membership, subscription, modules, audit). | Failure-injection test: a failing last insert leaves no organization. |
| Concurrency | Per-user advisory lock + "has membership" refusal serialises double submits. Slug collisions retried with a suffix. | Parallel-submit test. |
| Abuse | Public sign-up does not exist, so the caller is an existing authenticated account with no membership. Needs `routeRateLimit` (fail closed, per user and IP), a daily global cap, and `security_events` per attempt. | Define who may self-provision (verified email? operator flag?). |
| Audit | Function writes the `org.created` audit row in the new organization. | Test asserts one audit row with the actor. |
| Auth gate | Organization-less users are blocked outside `/api/auth/`; the route must be allow-listed there or live under `/api/auth/`. | Security-owner change to `auth.plugin.ts`. |
| RLS | One new INSERT policy on `organizations` for the provisioner role only; matches `app_current_*`, so the "no `USING (true)`" guardrail holds. | Update guardrail classification; upgrade test from 0018+. |

**Decision required from the security owner:** approve, amend (notably the `app_current_user()` binding), or reject.

## 5. Entitlement matrix and charging status

| Entitlement | Status |
|---|---|
| Subscription status, included minutes, concurrent calls | ENFORCED (`callAdmission`; see 0022-era reserve logic in `call-admission.ts`) |
| Active agents, team members (members + pending invitations) | ENFORCED (DB triggers, migration 0020) |
| Retention days, analytics tier, API access, webhooks | REMOVED 2026-10-21 (migration 0025, D3) - advertised but never enforced, so they are no longer plan entitlements at all |

Charging: no payment gateway, no webhook route, no invoice tables, and `paymentsEnabled` is `false` in the API. The
mock provider refuses `NODE_ENV=production`. A paid plan can only become active through a verified payment event, which
nothing can produce today. Real-customer billing therefore **cannot** charge, and must stay off until a gateway,
GST/invoicing, refunds and the business policies (prices, rounding, trial, overage) are approved.

## 6. Staging validation checklist (all NOT RUN)

Detailed procedure: `docs/security/operations-and-validation-plan.md` section 3 and
`docs/security/exotel-auth-capabilities.md`. Statuses are VERIFIED / FAILED / BLOCKED / NOT RUN; none has evidence.

| # | Item | Status | Evidence required |
|---|---|---|---|
| 1 | Exotel dynamic endpoint returns a per-call grant and Exotel's connect carries it (path vs query preserved) | NOT RUN | captured request log with grant redacted |
| 2 | Expired grant refused | NOT RUN | 4xx and security event |
| 3 | Replayed grant refused (second use) | NOT RUN | same |
| 4 | Missing grant refused; direct unauthenticated stream disabled | NOT RUN | same |
| 5 | Unauthorized stream attempt from a non-Exotel address | NOT RUN | same |
| 6 | Sarvam STT/TTS with real 8 kHz telephony audio | NOT RUN | recordings + latency metrics |
| 7 | Barge-in on a real call | NOT RUN | transcript + interrupt metric |
| 8 | Caller disconnect and interrupted call finalise and meter correctly | NOT RUN | call row + one ledger row |
| 9 | N concurrent calls; plan concurrency cap holds | NOT RUN | call rows + refusals |
| 10 | Multi-instance stream ownership (two API instances, one call) | NOT RUN | stream claim rows |
| 11 | Managed PostgreSQL with restricted runtime role; startup role check passes; migrations to 0022 | NOT RUN | startup log, catalog query |
| 12 | `/metrics` scraped by the real collector with token | NOT RUN | scrape screenshot/log |
| 13 | Alert rule fires and is delivered to a real receiver; failure to deliver is itself visible | NOT RUN | delivered alert |
| 14 | Per-IP behaviour behind the real load balancer: `TRUST_PROXY` correct, dashboard users not collectively throttled | NOT RUN | request log |

## 7. GitHub CI

`gh` is not installed on this machine, so authentication, repository access and run status could not be checked and no
workflow was triggered. **UNVERIFIED.** Steps (from `docs/security/ci.md`):

1. Owner commits and pushes the working tree to a branch (not done here).
2. Open a PR or merge to the default branch; the Security workflow runs on `pull_request`, push to default, and
   `workflow_dispatch`.
3. Actions -> "Security" -> inspect the four jobs (api, web, audit, e2e). Record the run URL and conclusion.
4. Known risks to watch: `pnpm audit --prod` needs registry access; `docker run postgres` step uses `--network host`;
   the new billing suites (`billing*.test.ts`, `e2e/billing-run.mjs`) are **not** referenced by the workflow and will
   only run inside the full `vitest run`; the billing browser e2e is not a CI job yet.

## 8. Prioritised production blockers

1. **Decision:** organization provisioning (security owner) and self-service onboarding.
2. **Decision:** shared-address rate limiting (guard vs forwarding) and `TRUST_PROXY` for the real topology.
3. Real-provider validation (section 6) with evidence; shared-secret stream risk stays open until grant propagation is proven.
4. GitHub CI run with URL and green result (add billing e2e/migration tests to the workflow).
5. Apply and verify 0020-0022 on staging managed PostgreSQL with the restricted role.
6. Retention policy approval (five decisions in `operations-and-validation-plan.md`).
7. Payments: gateway, signature verification route, GST invoices, refunds, dunning.
8. Business sign-off on prices, allowances, rounding, trial and overage.
9. ~~Unenforced advertised entitlements (retention, analytics)~~ CLOSED 2026-10-21 (D3): removed from the schema, the seeded plans and the plan copy by migration 0025.
10. External security review / penetration test of tenant isolation.
11. Dev-only `braces` advisory (low priority).

---

# Stabilization pass (stabilize.md, 2026-10-14)

## A. Root causes of the two earlier full-suite failures

| Test | Root cause | Evidence | Fix |
|---|---|---|---|
| `hardening.test.ts` "app logger masks secret keys and secrets embedded in strings" | **Race with a concurrent edit, not a code or test defect.** `shared/logger.ts` was being rewritten by another agent (mtime 19:52) while the suite was running. The failing output shows a logger that did not scrub nested strings (`"note":"Basic dXNlcjpwYXNz and va_session=sess2-secret"` unredacted), which the current file does. | Committed `logger.ts` differs from the working tree by 24 added lines (`git diff --stat`); 3 consecutive isolated runs: exit 0, 14/14 each | None needed; no test or logger change. |
| `conversation-streaming.test.ts` "emits the first chunk while the model is still generating" | **Genuinely timing-dependent assertion.** `handleUserUtterance` persists the caller's turn (`recordTurn`, a tenant-scoped database transaction) before the model is called; the test waited a fixed 20 ms before asserting the first chunk had arrived. Under full-suite database load that write exceeds 20 ms. Not reproducible with CPU load alone (8 busy processes: 3/3 passes), consistent with a database-latency cause. | code path `conversation.ts` `handleUserUtterance` -> `recordTurn` -> `runTurn` | Replaced the fixed sleep with a wait for the event (5 ms polling, 5 s ceiling). The assertion is unchanged and still proves the property: the chunk must arrive while `releaseTail()` has not been called; if chunks were only emitted at completion the test fails at the ceiling. |

Commands (dedicated database `voice_agent_test_billing`, restricted role `voice_app`):

| Command | Exit | Result |
|---|---|---|
| `vitest run src/modules/ai-agent/conversation-streaming.test.ts` | 0 | 20 passed |
| `vitest run src/security/hardening.test.ts` | 0 | 14 passed |
| `vitest run src/security src/modules/ai-agent` | 0 | 30 files, 391 passed |
| full `vitest run` (run 3) | **1** | 139 files passed, 4 skipped; 1879 passed, 13 skipped; **1 unhandled error: "Worker exited unexpectedly"** (one file's worker died, 20 tests not run; the file could not be identified from the default reporter output). Other agents were editing files during this run. |
| `vitest run src/modules/ai-agent/conversation-streaming.test.ts src/modules/billing/billing-security.test.ts src/modules/projects/csv.test.ts src/modules/projects/projects.management.test.ts` (every 20-test file) | 0 | 80 passed |
| full `vitest run --reporter=default --reporter=json` (run 4) | **0** | 140 files passed, 4 skipped; **1899 passed, 13 skipped, 0 failed, 0 errors** |

Status: **full suite green on the latest run (run 4).** The run-3 worker crash was not reproduced and its cause is not
established; treat it as an open flake to watch in CI (the JSON reporter is now the recommended way to identify it).

## B. Internal client-IP header

Decision memo: `docs/security/internal-client-ip-decision.md`. **Not implemented**: the API is reachable from the
public internet for Exotel, and in the current topology public traffic and web-server traffic can share the same peer
address, so the API cannot tell them apart; a static secret header would be replayable. Conservative behaviour retained.
Infrastructure requirement (separate internal listener, mTLS, or a stripping LB plus signed header) documented.

## C. Provisioning

`docs/billing/README.md` proposal amended: identity binding `p_user_id = app_current_user()` (VA004), dedicated NOLOGIN
`voice_provisioner`, minimal grants, `search_path = pg_catalog, pg_temp` with schema-qualified objects, exact
organization-less allow-list entry (`POST /api/workspaces` only), literal `OWNER`, atomic org/membership/trial/audit,
abuse controls, adversarial test list. Status: awaiting security-owner approval; nothing implemented.

## D. Migration 0022 review

* SQL: `REVOKE UPDATE ON billing_events`, `REVOKE UPDATE ON usage_ledger`, `GRANT UPDATE (state) ON usage_ledger` to
  `voice_app`. No table, policy, RLS flag, trigger or function changes; RLS unaffected (policies are evaluated in
  addition to privileges).
* Code compatibility: the only runtime update of either table is `usageLedgerRepository.supersede`
  (`SET state = 'superseded' ... RETURNING id`), which needs UPDATE(state) plus SELECT (held). No `$onUpdate` columns.
* Relationship: tightens 0019 (which only revoked DELETE); independent of 0020/0021; journal idx 22, snapshot consistent
  (`drizzle-kit check` "Everything's fine", `generate` wrote nothing).
* Rollback: `apps/api/src/db/rollback/0022_billing_grants_hardening.down.sql` (restores table-level UPDATE; loosens).
* Scratch-database results (`modules/billing/billing-migration.test.ts`, database `voice_agent_billing_mig_test`, part
  of run 4): upgrade from 0018 with data; catalog: no table-level UPDATE on either table, column UPDATE only on
  `usage_ledger.state`; as the runtime role inside a tenant scope: UPDATE of `billable_seconds` -> 42501, UPDATE of
  `billing_events` -> 42501, DELETE ledger -> 42501, `SET state='superseded'` succeeds; rollback restores UPDATE;
  re-running 0022 twice is idempotent and re-applies the restriction.
* Dev database: **not applied** (still 21 applied, last 0021). No migration records rewritten.

## E. Combined regression (latest, sequential, no overlapping runs)

| Check | Exit | Result |
|---|---|---|
| Full API suite (run 4) | 0 | 1899 passed, 13 skipped |
| Security e2e `node e2e/run.mjs` | 0 | off: 6 passed; enforce: 1 passed |
| Billing e2e on production build `node e2e/billing-run.mjs` | 0 | `next build` compiled; 8 passed |
| web `tsc --noEmit` / `next lint` | 0 / 0 | clean / no warnings |
| api `tsc --noEmit` / `eslint src` | 0 / 0 | clean / 0 errors, 13 warnings |
| `drizzle-kit check` / `generate` | 0 / 0 | no drift; 23 files before and after |
| `pnpm audit --prod` | 0 | No known vulnerabilities found |
| `pnpm audit` | 1 | 1 high, `braces` via dev-only eslint tooling (unchanged) |

### GitHub Actions (prepared, not run)

`.github/workflows/security.yml` now also runs, in job **api**, a named step `vitest run src/modules/billing` (billing
ledger, quotas, seat caps, migrations 0019-0022) before the full suite, and in job **e2e**,
`pnpm --filter @voice-agent/web e2e:billing` after the security e2e. YAML parses (js-yaml). To execute: owner pushes a
branch and opens a PR (or merges to the default branch, then Actions -> Security -> Run workflow); record the run URL and
the conclusion of jobs api, web, audit, e2e. **GitHub CI status: NOT RUN** (`gh` not installed; nothing pushed).

## Updated staging blockers (priority order)

1. Security-owner decisions: provisioning design (amended); internal client-IP topology (memo).
2. Open flake: run-3 "Worker exited unexpectedly" (not reproduced); watch in CI with the JSON reporter.
3. Real-provider validation checklist (14 items, all NOT RUN).
4. First real GitHub Actions run with URL, including the new billing steps.
5. Apply every migration to staging managed PostgreSQL and verify with the restricted role. (Dev is no longer at 0021 - check the real count with `select count(*) from drizzle.__drizzle_migrations`.)
6. Retention policy approval; payments/GST/refunds; business sign-off on prices and policies.
7. External penetration test; dev-only `braces` advisory. (Unenforced advertised entitlements: CLOSED 2026-10-21 by migration 0025, D3.)
