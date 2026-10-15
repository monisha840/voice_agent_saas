# Performance: cost of database-enforced tenant isolation (RLS)

Measured with `apps/api/src/scripts/bench-secure-vs-baseline.ts`. All numbers below are real output of that script
on the machine described under "Environment"; nothing is estimated.

## Methodology

* **BASELINE** = the same repository/drizzle code, routed through the owner (superuser) connection with no tenant
  scope (`runAsAdmin`): one plain statement per query, RLS bypassed. This is what the pre-RLS implementation did.
* **SECURED** = the runtime role `voice_app` (no superuser, no BYPASSRLS) through the application's scoped client
  (`db/client.ts`): every statement runs as `BEGIN` / `set_config(app.organization_id, app.user_id, local)` /
  statement / `COMMIT`, with RLS policies evaluated on every row access.
* The case bodies are identical in both modes; only the connection and the scope differ.
* Disposable database `voice_agent_bench_test` created from the repository migrations, seeded with 20 organizations x
  500 leads, 500 calls and 500 conversations each (owner connection). It is dropped at the end of every run.
* Per case and concurrency (1 and 16): 200 warmup operations (discarded) then 2000 timed samples. Order of
  baseline/secured alternates per case. Pool size 10 for both modes (so concurrency 16 queues on the pool).
* Connection usage is sampled every ~20 ms from `pg_stat_activity` (client backends of the bench database, bench
  control connections excluded): "max active" = most connections not idle at once for the mode's role.
* Cases: (1) lead by org+id; (2) 50-row list; (3) insert `audit_logs` + update a lead (2 statements, no explicit
  transaction); (4) `db.transaction` of insert + update + select; (5) call setup: `callsRepository.create` +
  `conversationsRepository.createForCall` + `callsRepository.updateStatus`; (6) `verifyStreamToken` +
  `streamTokenUsesRepository.consume` (the token-use table is not tenant-scoped, so SECURED runs it unscoped as
  the app does; tokens are pre-signed outside the timed section); (7) `conversationsRepository.appendTurn`
  (select + update).
* Script: `cd apps/api && npx tsx src/scripts/bench-secure-vs-baseline.ts` (env: `BENCH_SAMPLES`, `BENCH_WARMUP`,
  `BENCH_ORGS`, `BENCH_ROWS`, `BENCH_CONCURRENCY`, `BENCH_CASES`, `BENCH_JSON`). It refuses non-local servers.

### Caveats (read before quoting any number)

* **Local Docker PostgreSQL 16 on the same host, loopback network, no TLS, mock configuration only. No telephony or AI
  provider is involved.** Absolute latencies are not real-world latencies; a remote/managed database has much larger
  round-trip times, which makes the *number of round trips* matter more, not less.
* Results are hardware- and load-dependent (Windows 11 desktop, other processes running, OneDrive). Run-to-run
  noise of 10-30% was observed (compare the two full runs below). Use ratios, not absolute values.
* Single database server, a single Node process as load generator (it shares the CPU with PostgreSQL).
* Synthetic data (10k leads, 10k calls) fits in memory; no cold-cache or large-table behaviour is measured.

## Environment

PostgreSQL 16.14 (Docker, localhost), Node v24.15.0, postgres.js 3.4.9, drizzle-orm 0.45, pool max 10.
Owner role bypasses RLS (checked by the script, which aborts otherwise); `voice_app` is neither superuser nor
BYPASSRLS (reported by the script).

## Results A: current scoped client before any change (original `client.ts`)

| Case | Conc | Mode | Samples | Err | p50 ms | p95 ms | p99 ms | ops/s | Max active conns |
|---|---|---|---|---|---|---|---|---|---|
| 1. indexed read (lead by org+id) | 1 | baseline | 2000 | 0 | 2.03 | 2.51 | 3.36 | 477 | 1 |
| 1. indexed read (lead by org+id) | 1 | secured | 2000 | 0 | 5.25 | 7.33 | 10.51 | 180 | 1 |
| 1. indexed read (lead by org+id) | 16 | baseline | 2000 | 0 | 7.96 | 12.38 | 15.68 | 1900 | 10 |
| 1. indexed read (lead by org+id) | 16 | secured | 2000 | 0 | 14.78 | 21.47 | 24.56 | 1039 | 10 |
| 2. list (50 leads) | 1 | baseline | 2000 | 0 | 3.02 | 3.97 | 5.49 | 319 | 1 |
| 2. list (50 leads) | 1 | secured | 2000 | 0 | 6.02 | 7.46 | 11.64 | 161 | 1 |
| 2. list (50 leads) | 16 | baseline | 2000 | 0 | 13.81 | 20.97 | 29.27 | 1106 | 10 |
| 2. list (50 leads) | 16 | secured | 2000 | 0 | 22.09 | 32.33 | 38.65 | 718 | 10 |
| 3. insert audit + update lead | 1 | baseline | 2000 | 0 | 7.19 | 9.58 | 12.26 | 135 | 1 |
| 3. insert audit + update lead | 1 | secured | 2000 | 0 | 13.11 | 16.74 | 20.58 | 74 | 1 |
| 3. insert audit + update lead | 16 | baseline | 2000 | 0 | 18.61 | 24.98 | 34.15 | 825 | 10 |
| 3. insert audit + update lead | 16 | secured | 2000 | 0 | 30.52 | 38.64 | 42.35 | 510 | 10 |
| 4. db.transaction (3 stmts) | 1 | baseline | 2000 | 0 | 10.37 | 12.89 | 16.06 | 94 | 1 |
| 4. db.transaction (3 stmts) | 1 | secured | 2000 | 0 | 11.16 | 13.85 | 17.44 | 87 | 1 |
| 4. db.transaction (3 stmts) | 16 | baseline | 2000 | 0 | 27.42 | 35.46 | 39.16 | 572 | 10 |
| 4. db.transaction (3 stmts) | 16 | secured | 2000 | 0 | 32.56 | 42.92 | 48.17 | 483 | 10 |
| 5. call setup (3 repo calls) | 1 | baseline | 2000 | 0 | 11.77 | 16.92 | 22.24 | 81 | 1 |
| 5. call setup (3 repo calls) | 1 | secured | 2000 | 0 | 20.72 | 26.15 | 35.18 | 47 | 1 |
| 5. call setup (3 repo calls) | 16 | baseline | 2000 | 0 | 31.57 | 40.25 | 50.67 | 498 | 10 |
| 5. call setup (3 repo calls) | 16 | secured | 2000 | 0 | 49.79 | 62.45 | 70.46 | 316 | 10 |
| 6. stream auth (verify + consume) | 1 | baseline | 2000 | 0 | 4.03 | 5.35 | 6.54 | 240 | 1 |
| 6. stream auth (verify + consume) | 1 | secured | 2000 | 0 | 3.82 | 4.94 | 6.32 | 253 | 1 |
| 6. stream auth (verify + consume) | 16 | baseline | 2000 | 0 | 10.28 | 13.40 | 15.81 | 1557 | 10 |
| 6. stream auth (verify + consume) | 16 | secured | 2000 | 0 | 10.42 | 14.33 | 18.68 | 1506 | 10 |
| 7. appendTurn (select + update) | 1 | baseline | 2000 | 0 | 5.77 | 7.16 | 9.29 | 170 | 1 |
| 7. appendTurn (select + update) | 1 | secured | 2000 | 0 | 12.41 | 14.93 | 17.42 | 79 | 1 |
| 7. appendTurn (select + update) | 16 | baseline | 2000 | 0 | 17.74 | 30.00 | 42.37 | 787 | 10 |
| 7. appendTurn (select + update) | 16 | secured | 2000 | 0 | 30.02 | 38.27 | 44.33 | 520 | 10 |

Secured / baseline p50 ratio (A):

| Case | c=1 | c=16 |
|---|---|---|
| 1. indexed read | 2.58x | 1.86x |
| 2. list | 1.99x | 1.60x |
| 3. insert + update | 1.82x | 1.64x |
| 4. transaction | 1.08x | 1.19x |
| 5. call setup | 1.76x | 1.58x |
| 6. stream auth | 0.95x | 1.01x |
| 7. appendTurn | 2.15x | 1.69x |

All 28 runs had zero errors. At concurrency 16 both modes saturate the 10-connection pool (max active 10);
at concurrency 1 each uses exactly 1 connection. The scoped client does not hold extra connections: the scope lives
inside one short transaction on one pooled connection.

## Findings

1. **The overhead is round trips.** The original scoped client sends `BEGIN`, then `set_config`, then the statement,
   then `COMMIT`, awaiting each: 4 network round trips per application statement versus 1 for the baseline. A single
   indexed read goes from ~2-3 ms to ~5-6 ms locally (about +3 ms), a fixed per-statement cost that does not grow with
   the work the statement does. RLS policy evaluation itself was not separately measurable; the policies compare
   `organization_id` to a transaction setting and the queries remain index lookups.
2. **Multi-statement work inside one `db.transaction` pays the cost once** (case 4: ~1.1x p50), because the scope
   is set once for the whole transaction. This is the cheapest way to run a multi-statement unit.
3. **Stream-token auth is unaffected** (case 6: ~1.0x): the token-use table has no tenant column and runs unscoped,
   and JWT verification dominates.
4. **Call setup** (3 statements) costs ~1.8x p50 at c=1 and ~1.6x at c=16, about +9 ms locally; a per-call one-off,
   not per-audio-frame. Throughput at c=16 drops 20-35% for statement-heavy cases because each statement holds a
   connection for more round trips.

## Optimization applied: pipeline the scope with the statement

`ScopedQuery.run` in `apps/api/src/db/client.ts` now sends `set_config(...)` and the statement back-to-back inside
the same transaction instead of awaiting the scope first (4 round trips become 3: BEGIN, [set_config + statement],
COMMIT). Isolation is unchanged:

* Both are issued on the transaction's single connection and PostgreSQL executes messages in order, so the
  statement can never run before the transaction-local scope is set; the scope is still `set_config(..., true)`
  and still dies with the transaction.
* If `set_config` fails, the transaction is aborted and the already-queued statement is rejected by the server
  (`25P02`); the scope error is what propagates, and the statement's rejection is swallowed (no unhandled rejection).
* A statement failure still rolls back the transaction as before.
* Tests: `npx vitest run src/db src/security src/modules/tenancy` passes 13 files / 176 tests with the change
  (including `rls.test.ts`, which proves unscoped reads see nothing and a pooled connection never carries the
  previous tenant).

### Measured effect (secured mode, p50 ms; targeted A/B, original vs pipelined client, 2 interleaved runs)

| Case | Conc | original run 1 | pipelined run 1 | original run 2 | pipelined run 2 |
|---|---|---|---|---|---|
| 1. indexed read | 1 | 5.26 | 5.44 | 5.76 | 5.71 |
| 1. indexed read | 16 | 12.43 | 12.34 | 15.71 | 14.76 |
| 3. insert + update | 1 | 13.94 | 9.80 | 13.06 | 10.39 |
| 3. insert + update | 16 | 29.48 | 23.67 | 31.34 | 23.46 |
| 7. appendTurn | 1 | 16.18 | 9.48 | 11.73 | 9.99 |
| 7. appendTurn | 16 | 26.93 | 23.66 | 26.11 | 22.68 |

Multi-statement flows improved consistently (case 3: roughly -3 to -4 ms at c=1, -6 to -8 ms at c=16; case 7
similar), while the single-statement read (case 1) showed no measurable change in this setup. We do not have a
confirmed explanation for the latter; treat the gain as real for multi-statement paths and unproven for
single-statement reads.

### Results B: full run after the change

(Full 7-case run, same script; c=1 secured p95/p99 for cases 3, 5, 7 contain outliers from a noisy machine.)

| Case | c=1 secured/baseline p50 | c=16 secured/baseline p50 |
|---|---|---|
| 1. indexed read | 2.25x | 1.79x |
| 2. list | 1.73x | 1.53x |
| 3. insert + update | 1.90x | 1.31x |
| 4. transaction | 1.06x | 1.16x |
| 5. call setup | 1.85x | 1.36x |
| 6. stream auth | 1.02x | 1.00x |
| 7. appendTurn | 1.90x | 1.42x |

Raw: secured p50/p95/p99 ms (ops/s), c=16: case1 16.89/24.26/27.92 (910); case2 18.88/25.59/30.95 (828);
case3 26.22/33.81/38.98 (592); case4 30.51/38.04/42.08 (520); case5 47.17/59.65/84.26 (333);
case6 13.05/18.96/22.07 (1204); case7 23.25/30.67/34.98 (663). Zero errors in all runs. Baseline numbers drifted
between the two full runs (e.g. case 6 c=16 baseline 10.28 vs 13.10 ms), which is the noise floor of this setup.

## Further options (not implemented)

* Keep application work in one `db.transaction` where it is already a logical unit (scope set once).
* Collapsing `COMMIT` into the statement or setting the scope in the same SQL text (CTE) was rejected: evaluation
  order inside a single statement is not guaranteed relative to the policy check, so tenant isolation could not be
  proven.
* A server-side approach (per-role `ALTER ROLE ... SET`, or a session-level GUC) would reintroduce state on pooled
  connections and is deliberately avoided.
