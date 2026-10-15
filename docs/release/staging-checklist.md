# External staging checklist (release candidate)

Prepared 2026-10-14. Sources: `docs/security/exotel-staging-test-plan.md`, `exotel-auth-capabilities.md`,
`stream-direct-dependencies.md`, `operations-and-validation-plan.md`, `monitoring-deployment.md`,
`migration-reconciliation.md`. Open policy questions are in [decisions.md](decisions.md); migration 0022 procedure is in
[migration-review.md](migration-review.md).

## Rules

1. **Every item starts as `NOT RUN`. An item without evidence stays `NOT RUN`**, whatever the operator believes
   happened. A missing observation is FAIL/UNKNOWN, never PASS (`exotel-staging-test-plan.md` "Recording rule").
2. Allowed results: `NOT RUN`, `PASS`, `FAIL`, `UNKNOWN`, `BLOCKED (reason)`.
3. Staging only. No production numbers, no customer numbers, no production secrets. Authorisation for cost and real
   numbers is required first (`operations-and-validation-plan.md` section 3).
4. Evidence must have secrets redacted (`token`, `st`, `g`, Basic values, `METRICS_TOKEN`, DB passwords). Never paste a
   secret or grant into a ticket, chat or this file. Use a staging-only secret and rotate it after the series.
5. Record the git SHA and deployment id with every result.

Evidence block used by every item (copy into the run record; blank = not provided):

```
Date/time (UTC):            Operator:              Environment (host, SHA, deploy id):
Log excerpt (redacted):     Screenshot:            Query output:
Metric sample:              Run URL:               Exotel CallSid / x-request-id:
Result: NOT RUN
```

Item format: **Env** · **Pre** (preconditions) · **Steps** · **Pass** · **Evidence** · **Result**.

---

## 0. Prerequisites

**ST-00 Staging prerequisites in place**
- Env: staging. Pre: none.
- Steps: confirm each item of `exotel-staging-test-plan.md` section 0 (1-8): stable HTTPS host with trusted cert,
  `ws://` refused; staging env vars placed by owner (`TELEPHONY_PROVIDER=exotel`, new staging
  `EXOTEL_AGENTSTREAM_WEBHOOK_SECRET`, `STREAM_TOKEN_KEYS`, `EXOTEL_ACCOUNT_SID`, `STREAM_ALLOWED_ACCOUNT_SIDS=<staging sid>`,
  `STREAM_REQUIRE_GRANT=false`, `STREAM_INBOUND_DIRECT_ALLOWED=true`, `STREAM_GRANT_TTL_MS=600000`,
  `STREAM_GRANT_MAX_USES=3`, `METRICS_TOKEN`); non-production ExoPhone + flow; staging org/agent mapped; edge does not log
  query strings for `/api/telephony/exotel/*`; Exotel support ticket filed; rollback (plan section 11) ready; second
  person informed.
- Pass: all 8 confirmed with evidence; edge access-log sample shows paths without query strings.
- Evidence: as block. Result: `NOT RUN`

---

## 1. Exotel dynamic endpoint and grant propagation

Mapping of experiment ids (`exotel-auth-capabilities.md` section 4) to checklist ids:

| Experiment | Checklist ids | Plan step |
|---|---|---|
| E1 query on StreamUrl (outbound) | EX-05 | 2a |
| E2 length / encoding | EX-03 | 1c |
| E3 static applet URL pass-through | EX-01, EX-06 | 1a, 2b |
| E3b query/path on returned URL | EX-04 | 1d |
| E4 dynamic endpoint GET | EX-02, EX-14..EX-18 | 1b, 3a-3e |
| E5 Basic-auth URL | EX-08 | 2d |
| E6 callback auth | EX-09 | 2e |
| E7 reconnects | EX-10, GR-03 | 2e, 5 |
| E8 answered vs upgrade ordering | EX-11 | 2e |
| E9 CustomField / CustomParameters echo | EX-12 | - |
| E10 source IP capture | EX-13 | 2e |

**EX-01 (E3) Static applet URL pass-through, dummy values**
- Env: staging echo route / webhook.site (dummy values only). Pre: ST-00.
- Steps: Voicebot applet URL `wss://<echo>/x?token=DUMMY1&a=2`; place one inbound and one outbound-flow call; capture
  upgrade query names/lengths and `start.custom_parameters`.
- Pass: `token` and `a` arrive unchanged on the upgrade; record whether they also appear in `custom_parameters`.
- Evidence: as block. Result: `NOT RUN`

**EX-02 (E4) Dynamic endpoint GET shape, dummy values**
- Env: staging echo with custom 200 JSON response. Pre: ST-00.
- Steps: applet URL `https://<echo>/ep?token=DUMMY2`; respond `200 application/json {"url":"wss://..."}`; log method,
  all header names, query names, `Authorization` presence (value redacted), source IP, Exotel's response-time budget.
- Pass: `token=DUMMY2` present **or** `Authorization: Basic` present; parameter set equals
  `CallSid, CallFrom, CallTo, Direction, Created, DialWhomNumber, From, To, CurrentTime`.
- Evidence: as block. Result: `NOT RUN`

**EX-03 (E2) Length and encoding limits**
- Env: staging echo. Pre: ST-00.
- Steps: one param of 100, 255, 257, 400 chars; then 4 params; then `%2B`, `=`, `.`; repeat on StreamUrl (outbound,
  max 600 chars total) with a ~300-char JWS.
- Pass: exact echo up to 256 chars (applet) recorded; truncation point and malformed-key behaviour recorded.
- Evidence: as block. Result: `NOT RUN`

**EX-04 (E3b) Query vs path on the URL returned by the dynamic endpoint — gate G1**
- Env: staging echo. Pre: EX-02.
- Steps: endpoint returns `wss://<echo>/api/echo?g=DUMMYGRANT22CHARS_a`; second run path form `/api/echo/DUMMYGRANT22CHARS_a`.
- Pass: query form arrives intact (path-only = code change needed before grant track; neither = stop grant track).
- Evidence: as block. Result: `NOT RUN`

**EX-05 (E1) Outbound StreamUrl mode with `st`**
- Env: staging. Pre: ST-00; `EXOTEL_FLOW_APP_ID` unset.
- Steps: place one API outbound call; then repeat with `STREAM_ALLOW_STATIC_SECRET=false`.
- Pass: upgrade carries `st` (logged `[redacted]`); call attaches; `stream_token_uses` row; still attaches with static
  secret disabled.
- Evidence: as block (query output: `stream_token_uses` row count). Result: `NOT RUN`

**EX-06 Outbound flow mode, static Voicebot URL**
- Env: staging. Pre: `EXOTEL_FLOW_APP_ID` set; applet static `wss://...?token=<staging secret>`.
- Steps: place one API outbound call.
- Pass: attaches via `call_sid` (link race <= ~3 s); record whether `token` arrived.
- Evidence: as block. Result: `NOT RUN`

**EX-07 Inbound webhook then stream (flow 2)**
- Env: staging. Pre: Passthru/HTTP applet -> `/api/telephony/exotel/inbound?token=` ahead of Voicebot static URL.
- Steps: one inbound call to the staging ExoPhone.
- Pass: exactly one `calls` row (idempotent on CallSid); stream attaches.
- Evidence: as block (query: `select count(*) from calls where provider_call_id = '<CallSid>'`). Result: `NOT RUN`

**EX-08 (E5) Basic auth in URL**
- Env: staging. Pre: ST-00.
- Steps: applet URL `wss://anyuser:<staging secret>@<host>/api/telephony/exotel/media-stream`; then non-account
  user/password variations; then a `%`-encoded secret.
- Pass: upgrade has `Authorization: Basic`; accepted; behaviour of each variation recorded.
- Evidence: as block. Result: `NOT RUN`

**EX-09 (E6) Status callback authentication**
- Env: staging. Pre: ST-00.
- Steps: `StatusCallback=https://user:secret@<host>/...` and plain URL; log header names; look for `X-Exotel-*`
  signature; check `CustomField` echo; compare source IPs with support list.
- Pass: facts recorded (which credential form arrives, any signature, source IPs within list).
- Evidence: as block. Result: `NOT RUN`

**EX-10 (E7) Reconnect behaviour**
- Env: staging. Pre: EX-05 or EX-07 passing.
- Steps: drop the socket from our side mid-call and during ringing; count Exotel reconnects and URL reuse.
- Pass: reconnect count recorded; count <= `STREAM_TOKEN_MAX_USES` / `STREAM_GRANT_MAX_USES` (3); one stream per call
  (`stream_claims`).
- Evidence: as block. Result: `NOT RUN`

**EX-11 (E8) "Answered" callback vs WebSocket upgrade ordering**
- Env: staging. Pre: EX-07.
- Steps: timestamp answered callback vs upgrade over 20 calls.
- Pass: 20 pairs recorded; ordering distribution stated (informs `STREAM_STATIC_REQUIRE_PENDING_STATUS`).
- Evidence: as block. Result: `NOT RUN`

**EX-12 (E9) CustomField / CustomParameters echo**
- Env: staging. Pre: ST-00.
- Steps: Calls/connect with `CustomField=probe123`; separately `CustomParameters=a=b`; inspect `connected` and `start` frames.
- Pass: presence/absence of each value recorded for both frames.
- Evidence: as block. Result: `NOT RUN`

**EX-13 (E10) Source IP capture**
- Env: staging behind trusted proxy hop. Pre: support-provided ranges received.
- Steps: log `req.ip` for upgrade, callbacks, dynamic GET over 20+ calls (each Exotel region used).
- Pass: all observed IPs inside the supplied CIDR list; list, date and supplier recorded.
- Evidence: as block. Result: `NOT RUN`

**EX-14 (3a) Grant propagation, inbound, real credentials**
- Env: staging. Pre: G1 passed (EX-02, EX-04); applet in dynamic mode `https://<host>/api/telephony/exotel/stream-url?token=<staging secret>` (or Basic form); `STREAM_REQUIRE_GRANT=false`.
- Steps: one inbound call.
- Pass: logs show `GET /stream-url?...token=[redacted]` -> 200, then `media-stream?g=[redacted]`; `stream_grants` row
  `uses=1`; `start.call_sid` equals CallSid sent to endpoint; shared secret not on the stream request; call `in_progress`.
- Evidence: as block. Result: `NOT RUN`

**EX-15 (3b) Grant propagation, outbound flow**
- Env: staging. Pre: EX-14.
- Steps: API outbound call in flow mode with dynamic applet; record `Direction`.
- Pass: endpoint resolves existing row (no row created); grant attaches; `Direction` starts with `outbound`.
- Evidence: as block. Result: `NOT RUN`

**EX-16 (3c) Credential on the endpoint GET**
- Env: staging. Pre: EX-14.
- Steps: inspect which credential reaches `/stream-url`.
- Pass: exactly one of `token` query or `Authorization: Basic` arrives (recorded). Neither = endpoint unusable by secret.
- Evidence: as block. Result: `NOT RUN`

**EX-17 (3d) Endpoint latency and failure behaviour**
- Env: staging. Pre: EX-14.
- Steps: measure GET -> upgrade time; force one 401 (wrong token) and one 5xx.
- Pass: connect within Exotel's budget; on 401/5xx the call fails cleanly (drop vs retry recorded); no unbounded retry.
- Evidence: as block. Result: `NOT RUN`

**EX-18 (3e) Cross-tenant number hop**
- Env: staging. Pre: second mapped number in a second test org.
- Steps: one call to the second number.
- Pass: grant and call row belong only to that org (`calls.organization_id`); no cross-org row.
- Evidence: as block (query output). Result: `NOT RUN`

**EX-19 Audio format of real Exotel streams**
- Env: staging. Pre: EX-05, EX-07.
- Steps: log `start.media_format` for inbound and outbound (no audio stored).
- Pass: encoding, 8 kHz sample rate, frame sizes multiple of 320 bytes match `websocket/exotel-audio.ts`.
- Evidence: as block. Result: `NOT RUN`

**EX-20 Flag flip: `STREAM_INBOUND_DIRECT_ALLOWED=false` (gate G4)**
- Env: staging. Pre: staging inventory table (decisions.md D5) complete; no flow-1 number, or one deliberate flow-1 test number.
- Steps: set flag `false`, restart; one inbound + one outbound call per configured flow; one call to the flow-1 test number.
- Pass: flows 2/3/4/5 work; flow-1 call refused 1008 `unregistered_call_sid`, no call row created,
  `access.stream_denied` row, `stream_auth_denied_total{reason="unregistered_call_sid"}` incremented.
- Evidence: as block. Result: `NOT RUN`

**EX-21 Redaction check (repeat after every Exotel item)**
- Env: staging. Pre: any EX/GR item run.
- Steps: `grep -F "<staging secret>"` and the minted grant over app logs; inspect edge log lines; check Exotel dashboard
  call detail for the applet URL.
- Pass: zero hits in app logs; edge log paths without query strings; dashboard exposure recorded; secret rotated after series.
- Evidence: as block (grep counts only, never the value). Result: `NOT RUN`

---

## 2. Missing, expired, replayed and forged grants

Run from a machine that is **not** Exotel. GR-04..GR-12 run with `STREAM_REQUIRE_GRANT=false` and again with `true`
(record both in the evidence).

**GR-01 Expired grant**
- Env: staging. Pre: EX-14; `STREAM_GRANT_TTL_MS=5000`.
- Steps: mint a grant via `curl` to `/stream-url` (staging secret, CallSid of a ringing test call); wait 6 s; connect.
- Pass: 1008, `access.stream_denied` `reason="grant_expired"`; call row unchanged (`ringing`); no `stream_claims` row. TTL restored.
- Evidence: as block. Result: `NOT RUN`

**GR-02 Replay beyond `STREAM_GRANT_MAX_USES`**
- Env: staging. Pre: `STREAM_GRANT_MAX_USES=1`; self-minted grant.
- Steps: connect with `wscat`/script sending matching `start.call_sid`; close; connect again.
- Pass: first attaches; second 1008 `grant_reused`; `stream_grants.uses` = 1.
- Evidence: as block. Result: `NOT RUN`

**GR-03 Legitimate reconnect within max uses**
- Env: staging. Pre: `STREAM_GRANT_MAX_USES=3`; EX-10 recorded.
- Steps: force a real mid-call reconnect on a grant call.
- Pass: reconnects attach; observed reconnects <= max uses; call does not drop.
- Evidence: as block. Result: `NOT RUN`

**GR-04 No credential (missing grant)**
- Steps: connect to media-stream with no `g`, `st`, `token` or Basic.
- Pass: 1008 `token_required` or `unauthorized`; `security_events` row; `stream_auth_denied_total` incremented.
- Env/Pre: staging, ST-00. Evidence: as block. Result: `NOT RUN`

**GR-05 Forged grant (random 22-char `g`)**
- Steps: connect with random `g`.
- Pass: 1008 `grant_unknown`.
- Env/Pre: staging, ST-00. Evidence: as block. Result: `NOT RUN`

**GR-06 Grant of call X with `call_sid` of call Y (same org, then other org)**
- Steps: two live test calls; connect with X's grant and Y's CallSid.
- Pass: 1008 `grant_call_sid_mismatch` / `provider_call_mismatch`; Y status unchanged; no claim row.
- Env/Pre: staging, EX-14, EX-18. Evidence: as block. Result: `NOT RUN`

**GR-07 Valid `g` + correct secret + wrong `st`**
- Pass: 1008 with a `token_*` reason (a presented bad token is never rescued).
- Env/Pre: staging, EX-14. Steps: as named. Evidence: as block. Result: `NOT RUN`

**GR-08 Static secret only with `STREAM_REQUIRE_GRANT=true`**
- Pass: 1008 `grant_required`.
- Env/Pre: staging; flag set only for this item, then restored. Steps: connect with `token` only. Evidence: as block. Result: `NOT RUN`

**GR-09 Unknown `call_sid` + mapped `to`, `STREAM_INBOUND_DIRECT_ALLOWED=false`**
- Pass: 1008 `unregistered_call_sid` after ~3 s; call count unchanged.
- Env/Pre: staging, EX-20 config. Steps: synthetic stream with shared secret. Evidence: as block (before/after count). Result: `NOT RUN`

**GR-10 `/stream-url` without / with wrong secret**
- Pass: HTTP 401; no new `stream_grants` row.
- Env/Pre: staging. Steps: two `curl` GETs. Evidence: as block (row count before/after). Result: `NOT RUN`

**GR-11 Second concurrent stream on a live call**
- Pass: 1008 `stream_already_attached`; exactly one claim row.
- Env/Pre: staging, a live call. Steps: open a second socket for the same call. Evidence: as block. Result: `NOT RUN`

**GR-12 Non-Exotel source IP with edge allow-list on**
- Pass: refused at edge (403) before Node; no app log line.
- Env/Pre: staging with edge IP allow-list (decisions.md D5). Steps: connect from tester machine. Evidence: as block (edge log). Result: `NOT RUN`

**GR-13 Account SID not in `STREAM_ALLOWED_ACCOUNT_SIDS`**
- Pass: stream with absent/different `start.account_sid` refused 1008 with denial event.
- Env/Pre: staging, allow-list set. Steps: synthetic stream with `account_sid=test-account`. Evidence: as block. Result: `NOT RUN`

---

## 3. Real Sarvam with 8 kHz phone audio

No per-stage latency metric is exported by `/metrics` today; take timings from structured logs (by `requestId`/call id)
or an external stopwatch harness, and state the method in the evidence. Bound cost: fixed call count, max duration,
record provider spend.

**SV-00 Run configuration recorded**
- Env: staging. Pre: Sarvam staging key placed by owner; spend cap agreed.
- Steps: record `REALTIME_STT_PROVIDER`, `REALTIME_STT_STREAMING`, `REALTIME_LLM_STREAMING`, `REALTIME_TTS_STREAMING`,
  `REALTIME_BARGE_IN*`, Sarvam model ids, region; consent from every speaker; no customer audio.
- Pass: configuration and consent recorded.
- Evidence: as block. Result: `NOT RUN`

For SV-01..SV-04: **Env** staging over the real Exotel phone path (not studio audio); **Pre** SV-00, EX-19.
**Steps**: scripted conversations by native speakers, >= 50 turns per language (>= 200 total). **Pass**: per-stage
p50/p95/p99 recorded for STT first transcript, LLM first token, TTS first byte, end-to-end turn gap; STT error and
timeout rate recorded; p95 turn gap within the product budget (budget value: ______, to be set by product); transcript
quality noted on a sample. **Evidence**: as block + metric table below. **Result**: `NOT RUN`.

| ID | Language | Turns | STT first transcript p50/p95/p99 ms | LLM first token p50/p95/p99 ms | TTS first byte p50/p95/p99 ms | Turn gap p50/p95/p99 ms | Error % | Timeout % | Result |
|---|---|---|---|---|---|---|---|---|---|
| SV-01 | Tamil | | | | | | | | NOT RUN |
| SV-02 | Tanglish | | | | | | | | NOT RUN |
| SV-03 | English | | | | | | | | NOT RUN |
| SV-04 | Hindi | | | | | | | | NOT RUN |

**SV-05 Provider 429/5xx and timeouts**
- Env: staging. Pre: SV-00.
- Steps: induce provider errors (invalid key on a test call, rate burst within spend cap) and observe.
- Pass: circuit breaker opens; caller hears a graceful fallback or clean end; call reaches a terminal status; no crash.
- Evidence: as block. Result: `NOT RUN`

**SV-06 Spend recorded**
- Pass: provider spend for the series recorded against the cap. Env/Pre: after SV-01..05. Steps: read Sarvam dashboard. Evidence: as block. Result: `NOT RUN`

---

## 4. Barge-in

Barge-in is off by default (`REALTIME_BARGE_IN=false`; `REALTIME_BARGE_IN_MIN_SPEECH_MS` default 1000,
`REALTIME_BARGE_IN_ENERGY_RATIO` default 6).

**BI-01 Caller interrupts agent speech**
- Env: staging. Pre: `REALTIME_BARGE_IN=true`; SV-00.
- Steps: 20 interruptions (>= 1 s clear speech) during TTS playback, across languages.
- Pass: playback stops; interruption-to-silence time recorded (p50/p95); the caller's utterance is processed; no stale audio afterwards.
- Evidence: as block. Result: `NOT RUN`

**BI-02 False barge-in from noise / echo / backchannel**
- Env: staging. Pre: BI-01.
- Steps: 20 turns with background noise, speakerphone echo, short "hmm"/"haan" backchannels.
- Pass: false-interruption count recorded; rate within product tolerance (value: ______).
- Evidence: as block. Result: `NOT RUN`

**BI-03 Barge-in disabled baseline**
- Env: staging. Pre: `REALTIME_BARGE_IN=false`.
- Steps: speak over TTS 5 times.
- Pass: agent completes its utterance; caller speech handled per turn rules; no crash.
- Evidence: as block. Result: `NOT RUN`

---

## 5. Disconnects and reconnects

**DC-01 Caller hangs up mid-turn**
- Env: staging. Pre: EX-07.
- Steps: hang up while the agent is speaking and while STT is pending (5 each).
- Pass: call reaches terminal status; exactly one `usage_ledger` row per call (`call:<id>` / `:final`); `stream_claims` released; no orphan provider sockets.
- Evidence: as block (query). Result: `NOT RUN`

**DC-02 Our socket drops mid-call** — covered with EX-10/GR-03. Pass: reconnect attaches, one stream per call, call continues or ends cleanly.
- Env/Pre: staging, EX-10. Steps: kill the connection from the server side. Evidence: as block. Result: `NOT RUN`

**DC-03 API instance restart during a live call**
- Env: staging. Pre: one live call.
- Steps: restart the API process.
- Pass: call ends or reconnects cleanly; stale-call reaper closes it within `STALE_CALL_IN_PROGRESS_MS` (default 45 min, or the staging value); metered once.
- Evidence: as block. Result: `NOT RUN`

**DC-04 Duplicate / late status callbacks**
- Env: staging. Pre: EX-07.
- Steps: observe Exotel's natural duplicates; replay one callback by `curl` with the staging secret.
- Pass: idempotent transitions; no second ledger row; status not regressed.
- Evidence: as block. Result: `NOT RUN`

**DC-05 Sarvam socket drop mid-call**
- Env: staging. Pre: SV-00.
- Steps: block provider egress briefly during a call.
- Pass: error logged with call id; caller gets fallback or clean end; terminal status; metered once.
- Evidence: as block. Result: `NOT RUN`

---

## 6. Concurrency (step 1 -> 5 -> 10, never above the Exotel account limit)

For each step: **Env** staging; **Pre** DC-01 passing, account concurrent limit confirmed, `MAX_CONCURRENT_CALLS_PER_ORG` (default 10) and any plan
cap >= step size; **Steps** start N simultaneous real calls, hold 3 min, end them; **Pass** all N attach and converse; DB pool
usage and event-loop lag recorded; per-stage latency not degraded beyond budget; one ledger row per call; no
`stream_claim_conflicts_total` increase; **Evidence** as block + metric samples; **Result** `NOT RUN`.

| ID | Concurrent calls | Pool in use (max) | Event-loop lag p95 ms | Turn gap p95 ms | Errors | Result |
|---|---|---|---|---|---|---|
| CC-01 | 1 | | | | | NOT RUN |
| CC-02 | 5 | | | | | NOT RUN |
| CC-03 | 10 | | | | | NOT RUN |

**CC-04 Plan concurrent-call cap refusal**
- Env: staging, managed test org with plan cap N. Pre: CC-02.
- Steps: start N+1 calls.
- Pass: exactly N admitted; extra refused HTTP 429 `LimitExceededError`; other orgs unaffected.
- Evidence: as block. Result: `NOT RUN`

---

## 7. Managed PostgreSQL

**PG-01 Roles provisioned with correct attributes**
- Env: managed staging instance (same region as API). Pre: owner/admin access.
- Steps: create owner (migration) role and runtime role (`pnpm --filter @voice-agent/api db:provision-runtime-role`
  or provider equivalent); query `pg_roles` for owner, `voice_app`, runtime login, `voice_resolver`, `voice_retention`.
- Pass: runtime and `voice_app` are not superuser, no `BYPASSRLS`, no `CREATEROLE`/`CREATEDB`; `voice_resolver`/`voice_retention` `NOLOGIN`.
- Evidence: as block (query output). Result: `NOT RUN`

**PG-02 Backup before migration**
- Env: managed staging. Pre: PG-01.
- Steps: `pg_dump -Fc`; record sha256; test restore into a scratch database.
- Pass: dump, hash and restore exit 0 recorded.
- Evidence: as block. Result: `NOT RUN`

**PG-03 Migrations through 0022 with the owner role**
- Env: managed staging. Pre: PG-02; decisions.md D6 approved for staging; [migration-review.md](migration-review.md) gates met.
- Steps: `DATABASE_MIGRATION_URL=<owner>` `MIGRATION_TARGET_CONFIRM=<db>` `npm run db:migrate`; read `drizzle.__drizzle_migrations`.
- Pass: guard prints target (no password); exit 0; applied rows equal journal entries (no idx 16); hashes equal file sha256.
- Evidence: as block. Result: `NOT RUN`

**PG-04 Runtime role privilege checks**
- Env: managed staging. Pre: PG-03.
- Steps: start API with runtime role; run `has_table_privilege`/`has_column_privilege` for `voice_app` on `billing_events`,
  `usage_ledger`, `plans`; attempt an app-role UPDATE of `usage_ledger.billable_seconds`; start API once as owner role.
- Pass: startup role check passes as runtime; `billing_events` SELECT/INSERT only; `usage_ledger` UPDATE on `state` only;
  `plans` SELECT only; content-column UPDATE rejected; start as owner refused (`Refusing to start: database role ...`).
- Evidence: as block. Result: `NOT RUN`

**PG-05 RLS and migration suites against the managed endpoint**
- Env: throw-away database on the managed server. Pre: PG-01.
- Steps: `TEST_DATABASE_NAME=<throwaway> npx vitest run src/db/migration-upgrade.test.ts src/db/migrate-guard.test.ts src/db/rls.test.ts`
  (from `apps/api`), then full `pnpm test` against the same server.
- Pass: all pass as the real runtime role; counts and exit code recorded.
- Evidence: as block (run URL/log). Result: `NOT RUN`

**PG-06 Pooler mode**
- Env: managed staging via pooler. Pre: PG-05.
- Steps: record pooler mode; if PgBouncer transaction mode, set `DATABASE_PREPARE=false`; re-run PG-05 RLS suite through the pooler.
- Pass: suite green through the pooler; pooled-connection tests show no tenant context carry-over.
- Evidence: as block. Result: `NOT RUN`

**PG-07 Scoped-query latency**
- Env: managed staging. Pre: PG-03.
- Steps: run `scripts/bench-secure-vs-baseline.ts` at expected concurrency.
- Pass: p95 scoped single-statement read <= agreed budget (suggested 25 ms; value: ______).
- Evidence: as block. Result: `NOT RUN`

**PG-08 Failover drill**
- Env: managed staging. Pre: PG-06; one live test call.
- Steps: trigger provider failover / restart primary.
- Pass: `/ready` flips non-200 then recovers; in-flight call ends cleanly; after reconnect no tenant context leak (rls pooled tests re-run green).
- Evidence: as block (timeline). Result: `NOT RUN`

---

## 8. Metrics scraping and actual alert delivery

**MA-01 `/metrics` access controls**
- Env: staging. Pre: `METRICS_TOKEN` (>= 16 chars), `API_PRIVATE_HOSTS` set.
- Steps: request `/metrics` (a) via private host with token, (b) without token, (c) wrong token, (d) via public LB / with `X-Forwarded-For`.
- Pass: (a) 200; (b) 401 with `www-authenticate: Bearer`; (c) 401; (d) 404 (`runtime/metrics.routes.ts`). Token absent from logs.
- Evidence: as block (status codes only). Result: `NOT RUN`

**MA-02 Prometheus scrapes every instance on the private network**
- Env: staging monitoring. Pre: MA-01; scrape config per `monitoring-deployment.md` section 2 (`job_name: voice-agent-api`, `credentials_file`).
- Steps: check targets page and `up{job="voice-agent-api"}`.
- Pass: `up == 1` for every instance; instance labels carry no IPs.
- Evidence: as block (metric sample, screenshot). Result: `NOT RUN`

**MA-03 Rules and routing validated**
- Env: monitoring host. Pre: promtool/amtool available.
- Steps: `promtool check rules alert-rules.yml`, `promtool test rules alert-rules.test.yml`, `amtool check-config alertmanager.yml`, the three `amtool config routes test` commands in `monitoring-deployment.md` section 4.
- Pass: all `SUCCESS`; routes resolve to `oncall-pager`, `delivery-test`, `heartbeat` respectively; no placeholder receiver left empty.
- Evidence: as block. Result: `NOT RUN`

**MA-04 Watchdog heartbeat delivered**
- Env: staging monitoring. Pre: MA-03; real heartbeat receiver.
- Steps: confirm `Watchdog` arrives at `heartbeat` every ~5 min; briefly stop it (silence) and confirm the dead-man service alerts.
- Pass: arrival and missing-heartbeat alert both observed.
- Evidence: as block (message ids/screenshot). Result: `NOT RUN`

**MA-05 Synthetic alert to non-paging receiver**
- Env: staging monitoring. Pre: MA-03.
- Steps: POST `DeliveryTest` with `test=delivery-check` to `/api/v2/alerts` (`monitoring-deployment.md` section 5 step 2).
- Pass: HTTP 200; alert visible in `GET /api/v2/alerts`; notification at `delivery-test` after ~30 s; nothing at `oncall-pager`/`ops-default`.
- Evidence: as block. Result: `NOT RUN`

**MA-06 Consented pager test**
- Env: staging monitoring, working hours. Pre: MA-05; written consent and agreed time from the on-call person.
- Steps: POST `DeliveryTestPager`, `severity=critical`, no `test` label, annotation saying it is a test.
- Pass: page received by the consenting person; acknowledged; resolved.
- Evidence: as block (consent ref, page id). Result: `NOT RUN`

**MA-07 Application-level alert end to end**
- Env: staging only. Pre: MA-05; `RATE_LIMIT_FAIL_MODE=open`.
- Steps: stop staging DB briefly, send traffic.
- Pass: `RateLimitStoreFailOpen` reaches the warning receiver; DB restored.
- Evidence: as block. Result: `NOT RUN`

**MA-08 Stream-denial alert from real denials**
- Env: staging. Pre: GR-04..GR-13 executed in a burst.
- Steps: watch `stream_auth_denied_total` and alert `StreamAuthDenialSpike`.
- Pass: counter increments by reason; alert fires and routes to the expected receiver.
- Evidence: as block. Result: `NOT RUN`

---

## Sign-off

A section is signed only when every item in it is PASS (or an accepted FAIL/BLOCKED with a decision reference).

| Section | Items | PASS / total | Open FAIL/UNKNOWN/BLOCKED | Signed by (name, role) | Date (UTC) | Notes / decision refs |
|---|---|---|---|---|---|---|
| 0 Prerequisites | ST-00 | 0 / 1 | | | | |
| 1 Exotel dynamic endpoint and grants | EX-01..EX-21 | 0 / 21 | | | | |
| 2 Missing/expired/replayed/forged grants | GR-01..GR-13 | 0 / 13 | | | | |
| 3 Sarvam 8 kHz | SV-00..SV-06 | 0 / 7 | | | | |
| 4 Barge-in | BI-01..BI-03 | 0 / 3 | | | | |
| 5 Disconnects/reconnects | DC-01..DC-05 | 0 / 5 | | | | |
| 6 Concurrency | CC-01..CC-04 | 0 / 4 | | | | |
| 7 Managed PostgreSQL | PG-01..PG-08 | 0 / 8 | | | | |
| 8 Metrics and alert delivery | MA-01..MA-08 | 0 / 8 | | | | |
| **Release owner (overall)** | all | 0 / 70 | | | | |
