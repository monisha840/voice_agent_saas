# Monitoring and alerting

## Status: what exists and what does not

- The repository ships NO monitoring destination: no Prometheus, Alertmanager, Grafana, pager, Sentry wiring or log
  aggregator is configured in `infra/`, `docker-compose*.yml`, `.env.example` or the docs (the only mention is the
  aspirational `SENTRY_DSN=` line in `PROJECT_ARCHITECTURE.md`, which no code reads).
- **Alert delivery is UNVERIFIED.** `alert-rules.yml` is a ready-to-load rule file; nothing here proves any alert
  reaches a human. Whoever operates production must load the rules into their Prometheus-compatible system, route
  them in Alertmanager (or equivalent) and fire a test alert.

## Inventory of existing abstractions

| Abstraction | Where | What it gives |
|---|---|---|
| Structured JSON logger (`logger.info/warn/error`) | `apps/api/src/shared/logger.ts` | one JSON line per event, request id stamped, secrets scrubbed; the only "transport" is stdout/stderr |
| `getRateLimitBackendErrorCount()` | `security/rate-limits.ts` | in-process total of limiter store errors (tests / diagnostics); log line rate-limited to 1 per 30 s |
| Security events | `security/security-events.ts`, table `security_events` | durable audit rows (login throttled, stream denied, ...); a failed write logs the whole redacted event |
| Retention result | `runtime/security-janitor.ts` | `RetentionResult` (purged counts, error) plus log lines |
| `/health`, `/ready` | `runtime/health.routes.ts` | liveness and readiness (database, draining) for a load balancer |
| Startup role check | `runtime/db-role-check.ts`, `server.ts` | refuses to boot in production; warns elsewhere |

## Added: in-process metrics and `GET /metrics`

- Registry: `apps/api/src/runtime/metrics.ts` (counters and gauges, per process, declared up front). Label values
  are limited to short `[a-z0-9_.:-]` tokens (anything else becomes `other`) and at most 50 series per metric, so IPs,
  emails, ids and tokens cannot appear. Counters reset on restart; Prometheus `increase()` handles that.
- Endpoint: `GET /metrics`, Prometheus text format. Access rules:
  1. `METRICS_TOKEN` unset (or shorter than 16 chars) means 404;
  2. requests via a proxy/tunnel or a non-private Host (`API_PRIVATE_HOSTS`) get 404 even with the token;
  3. otherwise `Authorization: Bearer <METRICS_TOKEN>` is required (constant-time compare), else 401.
  It is listed explicitly in the login-gate public list (`auth/auth.plugin.ts`) because scrapers have no cookie.
  The global per-IP rate limit still applies to it (not in the exempt list; verified by `metrics.socket.test.ts`).
- Scrape config example (private network only): `authorization: { type: Bearer, credentials: <token> }` with the API
  instance DNS name listed in `API_PRIVATE_HOSTS`. Scrape every instance (state is per process).

| Metric | Labels | Incremented when |
|---|---|---|
| `rate_limit_backend_errors_total` | `mode` open/closed | limiter store error (same place as the existing log line) |
| `rate_limit_fail_open_total` | - | a request was served without limiting because of such an error |
| `stream_auth_denied_total` | `reason` (`token_*`, `grant_*`, `unauthorized`, `token_required`, `token_reused`); known values exported at 0 | media stream authentication denied |
| `stream_claim_conflicts_total` | `kind` local/db/lost | second stream for a call refused, or claim lost to another instance |
| `db_authorization_errors_total` | - | central error handler sees SQLSTATE 42501, `row-level security` or `permission denied` (also in `cause`) |
| `db_runtime_role_problems` (gauge) | - | startup role check problem count (0 healthy) |
| `db_role_check_failures_total` | `kind` problems/inspect_error | startup role check found problems or could not run |
| `security_event_retention_errors_total` / `_purged_total` | - | retention run failed / rows purged |
| `security_event_persist_failures_total` | - | `securityEvents.record` could not write |
| `security_janitor_failures_total` | `task` cleanup/retention | janitor step failed |
| `security_janitor_last_success_timestamp_seconds` (gauge) | - | last successful cleanup (0 until the first success in this process) |
| `auth_throttle_denied_total` | `kind` login/mfa | login or MFA attempt refused by the throttle |

## Alert rules (`docs/security/alert-rules.yml`)

Deployment, Prometheus/Alertmanager config and the safe delivery test: `monitoring-deployment.md`. Unit tests with
synthetic series: `alert-rules.test.yml` (promtool; executed and PASSING on 2026-10-21 - see
monitoring-deployment.md section 4).

| Alert | Expression (summary) | for | Severity | Rationale and known blind spots |
|---|---|---|---|---|
| RateLimitStoreFailOpen | increase fail_open 5m > 0 | 0m | warning | Per-IP protection was OFF. A `for` shorter than the window cannot filter a blip, so none is used. Blind: only counts requests that reached the hook. |
| RateLimitStoreFailOpenSustained | increase fail_open 10m > 0 | 10m | critical | Events across a full 10 m window: a real outage, not a deploy blip. |
| RateLimitStoreErrors | increase backend_errors 5m > 5 | 0m | critical | Fail-closed login/MFA return 503. Counts both modes (any DB trouble). |
| StreamAuthDenialSpike | increase stream_auth_denied 10m > 20 | 0m | warning | All reasons. Baseline is a handful. |
| StreamTokenIntegrityDenials | token_bad_signature, unknown_key, wrong_*, bad_claims, malformed > 3 / 10m | 0m | critical | Key-set mismatch between instances or forgery. Expired/missing excluded. |
| StreamReplayDenials | token_reused, grant_reused > 3 / 10m | 0m | warning | Replay or provider retry storm. |
| StreamClaimConflicts | sum by kind, > 3 / 15m | 0m | warning | Summed across instances: the cause may be on another instance. |
| DbAuthorizationErrors | increase > 0 / 5m | 0m | critical | Only errors reaching the central error handler; jobs/WS paths that swallow errors are invisible. |
| DbRuntimeRoleUnsafe | gauge > 0 | 0m | critical | Set at startup only; stays until restart. Production refuses to boot, then MetricsTargetDown fires. |
| DbRoleCheckFailed | counter value > 0 | 0m | critical | Bare value (set once at startup before the first scrape; increase() would miss it). Covers `inspect_error` where the gauge can stay 0. |
| SecurityEventRetentionFailing | increase > 0 / 1h | 0m | warning | Silent when retention is disabled (default); no "last retention success" metric. |
| SecurityEventPersistFailing | increase > 0 / 5m | 0m | critical | Audit row lost from the table; recover from the log line. If logging is also lost, so is the event. |
| SecurityJanitorFailing | cleanup failures > 2 / 30m | 0m | warning | Three consecutive failed 10 m ticks. Retention failures are counted by their own rule. |
| SecurityJanitorStale | time() - (last_success > 0 or process_start) > 3600 | 5m | warning | Falls back to process start while the gauge is 0, so a never-succeeding process fires after one hour. A janitor that stalls inside a hung query is caught only after an hour. |
| LoginThrottleSpike | kind=login > 30 / 10m | 0m | warning | Credential stuffing. Counted when the event is recorded, even if persistence fails. |
| MfaThrottleSpike | kind=mfa > 10 / 10m | 0m | warning | The password step already succeeded; lower threshold. |
| MetricsTargetDown | up{job="voice-agent-api"} == 0 | 5m | critical | Without it a dead/unscrapable instance silences everything. Job name must match the scrape config. |
| ApiRestartLoop | changes(process_start_time_seconds[30m]) > 2 | 0m | warning | Counters reset on restart; increments right before a crash are lost. |
| Watchdog | vector(1) | 0m | none | Always firing; routes to a heartbeat receiver (dead-man's switch). |

Cross-cutting caveats:

- **First increment.** `increase()` cannot see the first value of a series that has no earlier sample. Known label
  values (`mode`, `kind`, `task`, the stream denial reasons) are exported at 0 from process start so the first
  fail-open, denial or failure is visible. An unlisted reason value still loses its first increment.
- **Counter reset.** Restarts reset counters; `increase()` handles that, but events between the last scrape and a
  crash are lost. `ApiRestartLoop` exposes crash loops.
- **Per instance.** Counters live in each process; rules aggregate `sum by (instance)` so one noisy instance is
  identifiable. A fault split evenly across N instances can stay under a per-instance threshold.
- **Scrape gaps.** If Prometheus cannot reach an instance, its own rules cannot fire; only MetricsTargetDown can.
- **Rate limiting.** `/metrics` is subject to the global per-IP limit (it is not in the exempt list); it is
  rate-limited by the scraper's address, not by the token.
- **Evaluator limits.** `alert-rules.test.ts` is a minimal evaluator for the expression forms in the file and does
  not model `for:`, `sum by` grouping across series or label selectors; `alert-rules.test.yml` (promtool) does.
