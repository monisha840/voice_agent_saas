# Release candidate: security + billing (prepared 2026-10-15; status corrected 2026-10-21)

**Status: locally verified release candidate. NOT externally verified, NOT deployed.**
GitHub CI has still NOT RUN - see [ci-coverage.md](ci-coverage.md#how-to-get-ci-green-the-first-time) for the exact
steps that produce a first run (short version: pushing the current feature branch starts nothing; a pull request
into `master` does). Real-customer billing is not enabled.

**Corrections to this document, 2026-10-21** (the facts below superseded what the 2026-10-15 text asserted):

* **It is committed.** The release candidate was committed and pushed: `7f9cd53` (security and billing hardening)
  and `0432360` (customer dashboard, agent builder with knowledge base, number management). Blocker A1 is closed.
* **Migrations 0022, 0023 and 0024 shipped in `0432360` and the dev database is no longer at 0021.** This document
  no longer states a migration count, because the count changes with every migration. To get the real numbers at
  any time:
  * head of the committed set:
    `node -e 'const j=require("./apps/api/src/db/migrations/meta/_journal.json");console.log(j.entries.length, j.entries.at(-1).tag)'`
  * applied to a database: `select count(*), max(created_at) from drizzle.__drizzle_migrations;`
  * the two must agree; the Security workflow asserts exactly that on a throwaway database and prints
    `journal entries=<n> applied=<n>`.
  Decision D6 was about approving migration 0022 before it reached anything persistent; it has since been applied.
  Re-read D6 against reality before quoting it.
* **The Exotel block is fixed**: a real phone call now reaches the server. The formal `EX-*` / `GR-*` items in
  [staging-checklist.md](staging-checklist.md) are still `NOT RUN`, because they need recorded evidence, not
  because connectivity is unproven.
* **The top external blocker is now commercial, not technical: Exotel and Sarvam are not paid for at production
  level.** No production-grade volume can be bought or tested until they are. See blocker C13 below.
* **The product supports three languages - Tamil, Tanglish and English.** Any earlier mention of Hindi in this
  directory was wrong and has been removed.
* **D3 (unenforced `retentionDays` / `analytics`) is being resolved by removal**, not by building the features.
  See [decisions.md](decisions.md) D3.

| # | Deliverable | File |
|---|---|---|
| 1 | Release-candidate diff summary (+ proposed commit file list) | `rc-diff-summary.md`, `proposed-commit-manifest.txt` |
| 2 | Migration review (0000-0022, fresh/upgrade/dev-copy tests, runtime-role probes, 0022 procedure) | `migration-review.md` |
| 3 | CI coverage matrix + GitHub execution steps | `ci-coverage.md` (and `docs/security/ci.md`) |
| 4 | Product/security decision log (D1-D10; D3 being resolved by removal, the rest OPEN) | `decisions.md` |
| 5 | External staging checklist (69 items, all NOT RUN; was 70 before the Hindi item was removed) | `staging-checklist.md` |
| 6 | Final regression results | section below |
| 7 | Production blockers | section below |

## 6. Final regression (after the last code change)

**This is a historical record of one run on 2026-10-15, not a current statement.** The two "Dev DB" rows describe
what the dev database looked like that morning (before 0022-0024 were applied) and are kept for traceability. Do
not read any row of this table as today's state; re-run the commands and write a new, dated table instead.

Run 2026-10-15 05:24:30Z - 05:37:29Z, strictly serial (one process at a time; unique test database; `apps/web/.next`
deleted before the web steps; e2e suites on their own databases and ports, run one after the other). Before the run a
stale Next 14 dev server holding `apps/web/.next` was stopped; the API dev server (port 4000, dev DB, no shared
ports or databases with the run) was left alone.

| Step | Command (from repo root unless noted) | Result | Exit |
|---|---|---|---|
| Dev DB before | read-only `select count(*), max(created_at) from drizzle.__drizzle_migrations` | 21 rows, max 1791984931706 (= 0021) **as observed on 2026-10-15; 0022-0024 have been applied since** | - |
| API typecheck | `pnpm --filter @voice-agent/api typecheck` | clean | 0 |
| API lint | `pnpm --filter @voice-agent/api lint` | 0 errors, 13 warnings (pre-existing `no-explicit-any`) | 0 |
| Drift check | `apps/api`: `pnpm exec drizzle-kit check` | "Everything's fine" | 0 |
| Drift generate | `apps/api`: `pnpm exec drizzle-kit generate` | "No schema changes"; migrations dir sha256 identical before/after | 0 |
| API tests (restricted runtime role) | `apps/api`: `TEST_DATABASE_NAME=voice_agent_test_rcfinal2 npx vitest run` | **Test Files 140 passed, 4 skipped (144); Tests 1900 passed, 0 failed, 13 skipped (1913)**; 519 s | 0 |
| API build | `pnpm --filter @voice-agent/api build` | clean | 0 |
| Web typecheck | `pnpm --filter @voice-agent/web typecheck` (`next typegen && tsc --noEmit`) | clean | 0 |
| Web lint | `pnpm --filter @voice-agent/web lint` | clean | 0 |
| Web build | `pnpm --filter @voice-agent/web build` | clean | 0 |
| Security e2e (Playwright) | `pnpm --filter @voice-agent/web e2e` | MFA off phase: 6 passed; enforce phase: 1 passed (`off=PASS enforce=PASS`) | 0 |
| Billing e2e (Playwright) | `pnpm --filter @voice-agent/web e2e:billing` | 8 passed | 0 |
| Prod dependency audit | `pnpm audit --prod` | No known vulnerabilities | 0 |
| Full dependency audit | `pnpm audit` | 1 high: `braces` GHSA-vfj7-8cjw-p6xm, dev-only (eslint toolchain, 18 paths), no patched version available | 1 (expected, known) |
| Dev DB after | same read-only query | 21 rows, max 1791984931706 (unchanged **by that run**; later changed by applying 0022-0024) | - |

Cleanup: 18 leftover `voice_agent_test*` databases (from this and earlier sessions) were dropped. The server now holds
only `postgres` and `voice_agent_mvp`.

The +1 test compared with the previous baseline (1899) is the new 0021 -> 0022 upgrade test.

## 7. Blockers that prevent production release

**A. Process / repository (owner actions)**
1. ~~Nothing is committed.~~ **CLOSED 2026-10-21:** committed and pushed in `7f9cd53` and `0432360`. The standing
   rule still applies to every future commit: never include `.env*`, dumps, test artefacts or `_tmp-*` scratch
   scripts.
2. **GitHub CI NOT RUN.** A real "Security" + "CI" workflow run must succeed on the committed SHA; record the run
   URL. Then make "Security" a required check. Both workflow files were audited and fixed on 2026-10-21 (IPv6/
   `localhost` database hosts, too-tight job timeouts, missing `permissions` and `workflow_dispatch` in ci.yml);
   the step-by-step procedure, including why pushing a feature branch triggers nothing, is in
   [ci-coverage.md](ci-coverage.md#how-to-get-ci-green-the-first-time).
3. Independent security review of the combined change (RLS, auth/MFA, stream auth, billing) has not been done.

**B. Decisions (in `decisions.md`; all OPEN except D3, which is being resolved by removal; nothing was chosen silently)**
4. D1 minute-overshoot policy / 7,200 s billable cap / 60 s admission reserve.
5. D2 payment-event ordering (high-water mark or not). This blocks a real gateway.
6. ~~D3 unenforced `retentionDays` / `analytics` benefits~~ **BEING RESOLVED 2026-10-21 by option B (remove):** the
   entitlements are being taken out of the seeded plans and the schema rather than built. Treat as closed once the
   migration and the catalog change land; never advertise retention tiers or tiered analytics.
7. D4 legacy unmanaged organizations (grandfather, cut-off, trial).
8. D5 direct Exotel streams: the production inventory must be filled in and the `STREAM_*` posture chosen.
9. D6 migration 0022 approval (procedure in `migration-review.md` section 6). **Note 2026-10-21:** the "not applied
   anywhere persistent" premise no longer holds - 0022 was committed in `0432360` and has been applied to dev, so
   this record is now about recording the approval, not about gating the application.
10. D7 security-event retention (deletion stays OFF until approved).
11. D8 payment gateway gate: no real billing until the trust-boundary checklist is signed off.
12. D9 (owner-role TRUNCATE on ledger) and D10 (test runs set a known `voice_app` password on the test cluster): low,
    but need an explicit accept or fix.

**C. External validation (all items still NOT RUN in `staging-checklist.md`)**
13. **TOP EXTERNAL BLOCKER (2026-10-21): Exotel and Sarvam are not paid for at production level.** Everything in
    this group needs paid, production-grade accounts and an agreed spend cap before it can be executed at all.
    Connectivity itself is no longer the problem: the Exotel block is fixed and a real phone call reaches the
    server.
14. Exotel: dynamic endpoint, grant propagation, missing/expired/replayed grants, account-SID / edge IP checks, real
    audio format (EX-*, GR-*). `STREAM_REQUIRE_GRANT` stays opt-in until GR-* pass.
15. Sarvam with real 8 kHz phone audio across the three supported languages - Tamil, Tanglish and English; latency
    budget (SV-*). The p95 budget itself is not yet set by product.
16. Barge-in, disconnect/reconnect, concurrency 1 -> 5 -> 10 (BI-*, DC-*, CC-*).
17. Managed PostgreSQL: roles, backup, owner-run migrations, runtime-role privilege and RLS suite, pooler, latency,
    failover (PG-*).
18. Monitoring: private `/metrics` scrape, promtool/amtool rule tests, real alert delivery to an actual destination
    (MA-*). No destination is configured in this repo.

**D. Known, non-blocking**
- `braces` dev-only advisory (no patch upstream); 13 lint warnings; cosmetic import order (rc-diff-summary P6).
- Migration 0019 stored-hash mismatch on dev is deliberate and documented. Do not rewrite it.
