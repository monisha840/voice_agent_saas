# Operations: monitoring signals, retention decisions, and the real-provider validation plan

## 1. Monitoring signals that exist today

There is no metrics backend wired in (an in-process registry and a protected `/metrics` now exist: see monitoring.md); these are structured-log lines and database rows an operator can alert on
(JSON logs, each stamped with `requestId`). Alert on the *rate*, not single occurrences.

| Signal | Where | Meaning / action |
|---|---|---|
| `security-janitor: cleanup failed` | log (warn) | session / throttle / token-use / rate-bucket cleanup failed; tables grow until fixed |
| `security-janitor: security event retention failed` | log (error) | retention purge errored (`purged` count included); inspect DB privileges / function |
| `security-events: FAILED TO PERSIST (event preserved here)` | log (error) | an audit write failed; the full redacted event is in the log line: recover it and fix the database path |
| `rate-limit: counter store unavailable` | log (error) | the shared limiter's PostgreSQL store failed; behaviour is per `RATE_LIMIT_FAIL_MODE` (sensitive routes fail closed with 503) |
| `media-stream: connection rejected` / `stream refused` and rows `security_events.event_type = access.stream_denied` | log (warn) + table | stream authentication failures; a sustained spike means probing or a misconfigured peer (reason codes: `token_*`, `unauthorized`, `token_required`, `provider_call_mismatch`, `call_not_live`, `stream_already_attached`) |
| `media-stream: stream claim lost to another instance, closing` | log (warn) | a second instance took the shared stream claim; should be rare, investigate routing |
| `auth.login.throttled`, `auth.mfa.throttled` events | `security_events` | brute-force pressure; the `scope` metadata says pair / ip / account |
| `permission denied` / `row-level security` PostgresError in error logs | log (error) | the runtime role hit a privilege or RLS boundary: a missing tenant scope in new code, or a role/grant drift. Never "fix" by granting BYPASSRLS |
| startup refusal `Refusing to start: database role ...` | process exit | the runtime connected as owner/superuser/BYPASSRLS or RLS is not enabled |
| `/ready` != 200 | HTTP | database unreachable or draining |

Verified by tests: stream denials are recorded without tokens (`stream-auth.e2e.test.ts`), janitor failure does not
starve the other tasks and retention failure is logged (`retention.test.ts`), audit persistence failure is logged with
the full event (`account-security.test.ts`, `security-events.ts`), the startup role check (`runtime/db-role-check.test.ts`).
**Not verified**: delivery to an actual log aggregator / paging system (none is configured in this repository).

## 2. Retention: the five decisions required before deletion may be enabled

Deletion is OFF and cannot be switched on by accident: `SECURITY_EVENT_RETENTION_ENABLED=true` is ignored (and
startup validation fails) unless `SECURITY_EVENT_RETENTION_APPROVAL_REF` records the approval, and every period must
be a whole number of days ≥ 30 when enabled. Decisions needed from the business/legal owner:

1. **Retention periods** per category (`auth_session`, `mfa_config`, `access_denied`, `privileged_action`, `other`).
   Current values are conservative placeholders (400/730/400/730/400 days), *not* a legal determination.
2. **Archive owner** — whether purged rows are archived (`SECURITY_EVENT_RETENTION_ARCHIVE`), who owns and may read
   `security_events_archive`, and its own retention (the archive holds IPs and user agents and has no purge job).
3. **Category mapping** — confirm `membership.*` → security configuration (730) and `auth.account.*` → auth/session
   (400); the mapping lives in SQL function `app_security_event_category`.
4. **Legal hold** — there is no per-tenant or per-incident hold today; decide whether one is needed before enabling.
5. **Backup handling** — purged rows persist in backups until those age out; decide backup retention to match.

## 3. Controlled validation plan: managed PostgreSQL, Exotel, Sarvam

Everything measured so far is local Docker PostgreSQL with mock providers (see `performance.md`). None of it
predicts real latency. **Nothing below is executed until explicitly authorised (cost, real numbers, customer impact).**

### 3.1 Managed PostgreSQL (staging instance, same region as the API)
* Provision the runtime role and run migrations with the owner role; run `pnpm test` against a throw-away database
  on that server (RLS suite as the real runtime role).
* Re-run `scripts/bench-secure-vs-baseline.ts` with a network RTT representative of production. Expect the
  3-round-trip scoped statement to cost 3 × RTT; decision gate: p95 of a scoped single-statement read ≤ budget
  agreed with product (suggest ≤ 25 ms at the expected concurrency). If exceeded, move hot call-path reads into one
  `db.transaction` (scope set once) before considering any server-side session state (rejected for isolation reasons).
* Pooler: if PgBouncer transaction mode, set `DATABASE_PREPARE=false` and re-run the RLS suite through the pooler.
* Failure recovery: kill the primary / failover; confirm `/ready` flips, in-flight calls end cleanly, no tenant
  context leaks after reconnect (the pooled-connection tests in `rls.test.ts` against the managed endpoint).

### 3.2 Exotel (one account, one ExoPhone, a handful of calls to team-owned numbers)
* Audio format: confirm `media_format` (encoding, sample rate, frame size multiples of 320) matches
  `websocket/exotel-audio.ts` assumptions for inbound and outbound; log `start` payloads (no audio stored).
* Authentication: confirm whether the dashboard StreamUrl preserves query parameters (per-call `st` token) in
  StreamUrl mode; confirm what the Voicebot applet sends (`custom_parameters`, `account_sid`) — this decides
  whether `STREAM_ALLOW_STATIC_SECRET` can be turned off and whether account-sid allow-listing is usable.
* Stability: 30 consecutive calls; measure connect time, first-audio latency, reconnect behaviour when the peer drops,
  duplicate/late status callbacks; verify one stream per call under reconnect.
* Concurrency: step 1 → 5 → 10 simultaneous calls (match the account's limit); watch pool usage and event-loop lag.

### 3.3 Sarvam (STT/LLM/TTS) with real 8 kHz phone audio
* Language set: Tamil, Tanglish (Tamil-English code-mix) and English samples recorded over the phone path (not studio
  audio). These are the only three the product supports, and the only two selectable codes are `en-IN` and `ta-IN` —
  Tanglish is not a separate code but how `ta-IN` behaves with the provider in code-mix mode. Hindi and the other
  Indic languages are **not** supported and are not part of this validation; the runtime still copes with a caller who
  switches to Hindi, but that is graceful degradation, not a validated language.
* Per-turn budget: time to first transcript, LLM first token, TTS first byte, end-to-end turn gap; p50/p95/p99 over
  ≥ 200 turns; error and timeout rates; behaviour under provider 429/5xx (circuit breaker already implemented).
* Cost: bound the run (fixed call count, max duration) and record provider spend.

### 3.4 Exit criteria before production
RLS suite green on the managed instance as the runtime role; stream auth confirmed against the real provider path;
measured p95 turn gap within the product budget; failure-recovery drills passed; independent security review done;
retention policy approved (or deletion explicitly left disabled).
