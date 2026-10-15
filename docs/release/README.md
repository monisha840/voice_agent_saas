# Release candidate: security + billing (status 2026-10-15)

**Status: locally verified release candidate. NOT externally verified, NOT committed, NOT deployed.**
GitHub CI has NOT RUN. Migration 0022 is NOT applied to dev (dev stays at 0021). Real-customer billing is not enabled.

| # | Deliverable | File |
|---|---|---|
| 1 | Release-candidate diff summary (+ proposed commit file list) | `rc-diff-summary.md`, `proposed-commit-manifest.txt` |
| 2 | Migration review (0000-0022, fresh/upgrade/dev-copy tests, runtime-role probes, 0022 procedure) | `migration-review.md` |
| 3 | CI coverage matrix + GitHub execution steps | `ci-coverage.md` (and `docs/security/ci.md`) |
| 4 | Product/security decision log (D1-D10, all OPEN) | `decisions.md` |
| 5 | External staging checklist (70 items, all NOT RUN) | `staging-checklist.md` |
| 6 | Final regression results | section below |
| 7 | Production blockers | section below |

## 6. Final regression (after the last code change)

Run 2026-10-15 05:24:30Z - 05:37:29Z, strictly serial (one process at a time; unique test database; `apps/web/.next`
deleted before the web steps; e2e suites on their own databases and ports, run one after the other). Before the run a
stale Next 14 dev server holding `apps/web/.next` was stopped; the API dev server (port 4000, dev DB, no shared
ports or databases with the run) was left alone.

| Step | Command (from repo root unless noted) | Result | Exit |
|---|---|---|---|
| Dev DB before | read-only `select count(*), max(created_at) from drizzle.__drizzle_migrations` | 21 rows, max 1791984931706 (= 0021) | - |
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
| Dev DB after | same read-only query | 21 rows, max 1791984931706 (unchanged) | - |

Cleanup: 18 leftover `voice_agent_test*` databases (from this and earlier sessions) were dropped. The server now holds
only `postgres` and `voice_agent_mvp`.

The +1 test compared with the previous baseline (1899) is the new 0021 -> 0022 upgrade test.

## 7. Blockers that prevent production release

**A. Process / repository (owner actions)**
1. Nothing is committed. The working tree must be reviewed and committed per `proposed-commit-manifest.txt`, never
   including `.env*`, dumps or test artifacts.
2. **GitHub CI NOT RUN.** A real "Security" + "CI" workflow run must succeed on the committed SHA; record the run URL.
   Then make "Security" a required check.
3. Independent security review of the combined change (RLS, auth/MFA, stream auth, billing) has not been done.

**B. Decisions (all OPEN in `decisions.md`; nothing was chosen silently)**
4. D1 minute-overshoot policy / 7,200 s billable cap / 60 s admission reserve.
5. D2 payment-event ordering (high-water mark or not). This blocks a real gateway.
6. D3 unenforced `retentionDays` / `analytics` benefits (build, remove or relabel before selling them).
7. D4 legacy unmanaged organizations (grandfather, cut-off, trial).
8. D5 direct Exotel streams: the production inventory must be filled in and the `STREAM_*` posture chosen.
9. D6 migration 0022 approval (procedure ready in `migration-review.md` section 6; not applied anywhere persistent).
10. D7 security-event retention (deletion stays OFF until approved).
11. D8 payment gateway gate: no real billing until the trust-boundary checklist is signed off.
12. D9 (owner-role TRUNCATE on ledger) and D10 (test runs set a known `voice_app` password on the test cluster): low,
    but need an explicit accept or fix.

**C. External validation (all NOT RUN in `staging-checklist.md`)**
13. Exotel: dynamic endpoint, grant propagation, missing/expired/replayed grants, account-SID / edge IP checks, real
    audio format (EX-*, GR-*). `STREAM_REQUIRE_GRANT` stays opt-in until GR-* pass.
14. Sarvam with real 8 kHz phone audio across Tamil, Tanglish, English and Hindi; latency budget (SV-*). The p95 budget
    itself is not yet set by product.
15. Barge-in, disconnect/reconnect, concurrency 1 -> 5 -> 10 (BI-*, DC-*, CC-*).
16. Managed PostgreSQL: roles, backup, owner-run migrations, runtime-role privilege and RLS suite, pooler, latency,
    failover (PG-*).
17. Monitoring: private `/metrics` scrape, promtool/amtool rule tests, real alert delivery to an actual destination
    (MA-*). No destination is configured in this repo.

**D. Known, non-blocking**
- `braces` dev-only advisory (no patch upstream); 13 lint warnings; cosmetic import order (rc-diff-summary P6).
- Migration 0019 stored-hash mismatch on dev is deliberate and documented. Do not rewrite it.
