# Exotel staging test plan: dynamic endpoint, grants, credentials, expiry, replay, forgery

**Status of every claim in this plan: NOT VERIFIED. Nothing below has been executed against real Exotel.** The code side
(grant minting, consumption, expiry, replay, binding, redaction) is covered by local tests with a fake "phone"
(`stream-grants.e2e.test.ts`, `stream-direct-disabled.e2e.test.ts`, `stream-leak-audit.e2e.test.ts`). Whether Exotel
calls the dynamic endpoint with credentials, preserves the `?g=` query on the WebSocket connect, or enforces the
documented limits is **unknown until the experiments below are run and their results recorded**. Until then
`STREAM_REQUIRE_GRANT` stays `false` and the dynamic-endpoint design must not be described as working or secure.

Experiment ids E1-E10 match `exotel-auth-capabilities.md` section 4. This plan orders them and adds pass/fail criteria.

## 0. Prerequisites (all must be true before step 1)

1. A **staging** deployment (not production, not a developer laptop tunnel) on a stable HTTPS hostname with a publicly
   trusted certificate, `EXOTEL_WEBHOOK_BASE_URL=https://<staging-host>`, TLS terminated at the proxy, `ws://` refused.
2. Staging environment (secrets placed by the owner, never pasted into tickets or chat):
   `TELEPHONY_PROVIDER=exotel`, `EXOTEL_AGENTSTREAM_WEBHOOK_SECRET` (new random, URL-safe, 32+ bytes, **not** the
   production value), `STREAM_TOKEN_KEYS`, `EXOTEL_ACCOUNT_SID`, `STREAM_ALLOWED_ACCOUNT_SIDS=<staging account sid>`,
   `STREAM_REQUIRE_GRANT=false`, `STREAM_INBOUND_DIRECT_ALLOWED=true` (flipped to `false` in step 9),
   `STREAM_GRANT_TTL_MS=600000`, `STREAM_GRANT_MAX_USES=3`, `METRICS_TOKEN` set.
3. A **non-production ExoPhone** and a non-production App Bazaar flow; a staging organization with one agent mapped to that
   number; a mobile number the tester controls for the outbound legs. No customer numbers.
4. Capture tooling: (a) a throw-away `webhook.site` URL used **only with dummy parameters** (never a real secret or
   grant: webhook.site is a third party); (b) our staging logs with redaction on (the app masks `token`, `st`, `g`, Basic
   values; verify by `grep -c '\[redacted\]'`); (c) read access to `security_events` (type `access.stream_denied`),
   `stream_grants` (hash only), `calls`; (d) `/metrics` over the private path with `METRICS_TOKEN`.
5. Edge: proxy/CDN access logs for `/api/telephony/exotel/*` **do not record query strings**. Confirm before any call, else
   every grant/secret lands in the edge logs.
6. Exotel support ticket (exotel-auth-capabilities.md section 4 questions) filed so written answers can be compared with
   observation: IP ranges, query preservation, limits, `CustomField`, endpoint authentication.
7. Build under test = the commit that contains the tests above; record the git SHA and deployment id with every result.
8. Rollback ready (section 11) and a second person informed; no production flow is touched.

Recording rule: for each experiment write date/time (UTC), Exotel CallSid, our request id (`x-request-id`), the observed
fact, and pass/fail. A missing observation is a **fail/unknown**, never a pass.

## 1. Dummy-parameter experiments (webhook.site only; no real credentials)

Purpose: learn what Exotel does with URLs before any real secret or grant is involved.

| Step | Experiment | Dashboard configuration | Capture | Pass | Fail / unknown means |
|---|---|---|---|---|---|
| 1a | **E3 static URL pass-through** | Voicebot applet URL `wss://<webhook.site-ws-capable-host or staging echo>/x?token=DUMMY1&a=2` (if webhook.site cannot do wss, use a staging echo route that logs query **names and lengths only**) | the upgrade request's query (names, lengths), `start.custom_parameters` | `token` and `a` arrive unchanged on the upgrade; note whether they also appear in `custom_parameters` | query dropped/mangled: static `?token=` is not a credential channel; flow/inbound rely on Basic or IP only |
| 1b | **E4 dynamic endpoint GET shape** | Voicebot applet URL `https://<webhook.site>/ep?token=DUMMY2` (HTTP applet type; response must be `200 application/json {"url":"wss://..."}`; webhook.site's default response will not satisfy it, so use its custom-response feature or the staging echo route) | method, **all headers**, query names, `Authorization` (value redacted), source IP, response-time budget Exotel enforces | `token=DUMMY2` present on the GET **or** `Authorization: Basic` present; list of parameters equals the documented set (`CallSid, CallFrom, CallTo, Direction, Created, DialWhomNumber, From, To, CurrentTime`) | custom params / credentials not sent: the endpoint cannot be authenticated by secret; it would be reachable only by IP allow-list (E4 fail) |
| 1c | **E2 length / encoding** | applet URL with 1 param of 100, 255, 257, 400 chars; then 4 params; then `%2B`, `=`, `.` characters | lengths received | exact echo up to the documented 256 chars; behaviour beyond it recorded | truncation point sets the maximum grant/URL size; our grant URL is about 100 chars |
| 1d | **E3b query on the URL *returned* by the endpoint** | endpoint returns `{"url":"wss://<staging-echo>/api/echo?g=DUMMYGRANT22CHARS_a"}` and, in a second run, a path form `/api/echo/DUMMYGRANT22CHARS_a` | upgrade query / path as received | query form arrives intact **or** path form arrives intact | **Critical**: if neither arrives, per-call grants cannot work; stop the grant track (steps 4-8) |

Do not continue to step 2 until 1b and 1d are recorded. If 1d fails for the query form but passes for the path form, a code
change (path-embedded grant) is required before any further grant experiment; do not improvise it in staging.

## 2. Static baseline on staging (our code, real Exotel)

| Step | Experiment | Config | Pass |
|---|---|---|---|
| 2a | Outbound, StreamUrl mode (**E1**) | `EXOTEL_FLOW_APP_ID` unset; place one API call | upgrade carries `st` (and `token` if `STREAM_ALLOW_STATIC_SECRET=true`); call attaches; `stream_token_uses` row; then repeat with `STREAM_ALLOW_STATIC_SECRET=false`: still attaches |
| 2b | Outbound, flow mode | `EXOTEL_FLOW_APP_ID` set, Voicebot applet static `wss://...?token=<staging secret>` | attaches via `call_sid`; record whether `token` arrived (E3) |
| 2c | Inbound webhook then stream | Passthru/HTTP applet -> `/inbound?token=`, then Voicebot static URL | one call row (idempotent), stream attaches |
| 2d | **E5 Basic auth** | applet URL `wss://anyuser:<staging secret>@<host>/api/telephony/exotel/media-stream` | upgrade has `Authorization: Basic`; accepted. Then non-account user/password variations (a1 UNKNOWN) and a `%`-encoded secret |
| 2e | **E6/E7/E8/E10** | as in exotel-auth-capabilities.md | reconnect count, "answered" vs upgrade ordering over 20 calls, source IPs (compare with Exotel's list) |

## 3. Dynamic endpoint with real credentials (only if 1b and 1d passed)

Dashboard: inbound flow -> Voicebot applet in "dynamic URL" mode:
`https://<staging-host>/api/telephony/exotel/stream-url?token=<STAGING secret>` (one custom param; within 3 / 256) **or** the
Basic form if 1b showed Basic is sent. Keep `STREAM_REQUIRE_GRANT=false`.

| Step | Experiment | Observation (our logs + DB, redacted) | Pass criteria | Fail criteria |
|---|---|---|---|---|
| 3a | **Grant propagation, inbound** | 1 inbound call. Logs: `GET /stream-url?...token=[redacted]` -> 200; then `media-stream?g=[redacted]`; `stream_grants` row with `uses=1`; call `in_progress` | `g` present on the upgrade (our log shows `g=[redacted]` on the media-stream request line) **and** `start.call_sid` equals the CallSid sent to the endpoint **and** the shared secret was **not** on the stream request | upgrade has no `g` (falls to static or is refused `token_required`/`unauthorized`); or `call_sid` differs (`grant_call_sid_mismatch`) |
| 3b | **Grant propagation, outbound flow** | API-initiated outbound in flow mode; `Direction` value recorded (`outbound-api`/`outbound-dial`) | endpoint resolves the existing row (no row created), grant attaches | endpoint 404 (CallSid not linked yet: record the delay; code waits about 3 s) or `Direction` not starting with `outbound` (then it would try to register an inbound call: record and stop) |
| 3c | **Credential behaviour on the endpoint GET** | webhook-secret query and/or Basic reach `/stream-url` | exactly one of: `token` arrives; `Authorization: Basic` arrives. Record which | neither arrives: the endpoint answers 401 and the call has no audio; **the endpoint is unusable by secret**, record and fall back to IP allow-list design (owner decision) |
| 3d | **Latency / failure behaviour** | time from GET to upgrade; force one 401 (wrong token) and one 5xx | Exotel connects within its budget; on 401/5xx the call fails cleanly (record whether it drops or retries) | audio never starts or Exotel retries unboundedly |
| 3e | **Hop to a different tenant number** | a second mapped number in another test org | the grant belongs to that org's call only (check `calls.organization_id`) | any cross-org row |

## 4. Expired grant

Set `STREAM_GRANT_TTL_MS=5000` (minimum). Place a call but delay the stream: use a flow with a greeting/wait applet longer
than 5 s before the Voicebot applet **if** the endpoint is hit at the start, or call the endpoint by hand with
`curl` (staging secret, a CallSid of a ringing outbound test call) and let 6 s pass before the call is answered.
Pass: stream refused, close `1008`, `access.stream_denied` with `reason="grant_expired"`, call row untouched
(`ringing`), no `stream_claims` row. Restore the TTL afterwards. Fail: the stream attaches after expiry.

## 5. Replay beyond STREAM_GRANT_MAX_USES

Set `STREAM_GRANT_MAX_USES=1`. Replay needs the plaintext grant, and the database holds only its hash, so use a test-only
call whose grant you minted yourself with `curl` against `/stream-url` (staging secret, from a shell on the staging host):
connect once with a script/`wscat` sending `start.call_sid` = that CallSid, close, then connect a second time.
Pass: first connect attaches; after it closes, the second is refused `grant_reused` (1008); `stream_grants.uses` stays 1.
Also run the legitimate-reconnect case with `STREAM_GRANT_MAX_USES=3` and E7 (Exotel reconnect count): the number of
reconnects Exotel really performs must be <= max uses, otherwise calls drop mid-call. Fail: replay attaches or
`uses` exceeds the cap.

## 6. Unauthorized and forged attempts (run from a machine that is **not** Exotel)

With `STREAM_REQUIRE_GRANT=false` and again with `true`:

| Attempt | Expected | Evidence |
|---|---|---|
| connect with no credential | 1008, `token_required` or `unauthorized` | `security_events`, `stream_auth_denied_total` |
| random 22-char `g` | 1008, `grant_unknown` | idem |
| `g` of call X with `start.call_sid` of call Y (same and other org) | 1008, `grant_call_sid_mismatch` / `provider_call_mismatch`; Y untouched | call Y status unchanged, no claim |
| valid `g` plus the correct secret but wrong `st` | 1008 (a presented token is never rescued) | `token_*` reason |
| static secret only, `STREAM_REQUIRE_GRANT=true` | 1008, `grant_required` | idem |
| unknown `call_sid` + mapped `to`, `STREAM_INBOUND_DIRECT_ALLOWED=false` | 1008, `unregistered_call_sid`, no call created | call count unchanged |
| `/stream-url` without/with wrong secret | 401, no `stream_grants` row | row count unchanged |
| second concurrent stream on a live call | 1008, `stream_already_attached` | one claim row |
| connect from a non-Exotel IP once the edge allow-list is on | refused at the edge (403) before Node | edge log |

Also confirm the secret/grants never appear in: app logs, edge logs (query stripped), Exotel's call logs/dashboard
(**note**: Exotel's own logs are out of our control: record whether the applet URL shows the secret in the dashboard
UI or call detail, and rotate afterwards).

## 7. Redaction check (every run)

After each step run: `grep -F "<the secret>" <log files>` and the same for the minted grant (use a **staging-only** secret
that you are willing to burn). Expect zero hits in app logs; the edge log must show paths without query strings. Rotate the
staging secret after the test series regardless.

## 8. Decision gates

| Gate | Condition | Allowed next action |
|---|---|---|
| G1 | 1b + 1d recorded | proceed to step 3; otherwise stop the grant track |
| G2 | 3a-3e pass on both inbound and outbound-flow | the dynamic endpoint can be *described* as working on staging, for the tested Exotel account/region only |
| G3 | G2 + 20 consecutive successful calls + E7/E8 recorded + expired/replay/forged all pass | owner decision whether to set `STREAM_REQUIRE_GRANT=true` in **staging**, then production, number by number |
| G4 | owner decision on `STREAM_INBOUND_DIRECT_ALLOWED=false` | after the dashboard inventory in `stream-direct-dependencies.md` shows no bare-Voicebot inbound number |

## 9. Flag flip order (staging, one at a time, each followed by one inbound + one outbound call)

1. `STREAM_INBOUND_DIRECT_ALLOWED=false` (expect: only flow 1 numbers fail; see dependency table).
2. `STREAM_ALLOW_STATIC_SECRET=false` **only** for numbers/flows that use the dynamic endpoint or StreamUrl `st`.
3. `STREAM_REQUIRE_GRANT=true` last, only if every flow is on the dynamic endpoint (G3). Never as a default.

## 10. What this plan cannot prove

* Exotel's behaviour outside the tested account, region (India/Singapore) and time; documentation versions change.
* That Exotel itself keeps URLs out of its logs/support tooling.
* Anything about production load; no load test is included.
* Source-IP stability: ranges come from Exotel support and must be re-confirmed periodically.

## 11. Rollback

1. `STREAM_REQUIRE_GRANT=false`, `STREAM_INBOUND_DIRECT_ALLOWED=true`, `STREAM_ALLOW_STATIC_SECRET=true`, restore
   `STREAM_GRANT_TTL_MS`/`STREAM_GRANT_MAX_USES` and age limits; restart/redeploy staging.
2. In the Exotel dashboard point the Voicebot applet back to the static `wss://<host>/api/telephony/exotel/media-stream?token=<secret>`
   (or Basic form) and, for inbound, keep the webhook applet in front.
3. Rotate the staging shared secret (it was in applet URLs and possibly Exotel logs); update every applet URL; place one
   test call per path.
4. Purge test rows only through the existing janitor (expired `stream_grants` are deleted automatically); do not hand-delete
   `security_events`.
5. Record the outcome and attach it to the decision log; leave `final_security.md` status as **blocked/unverified** for
   anything not passed above.

## 12. Result template

```
Experiment: <id>   Date (UTC):   SHA/deploy:   Exotel CallSid:   request id:
Observed:   (facts only; redacted values)
Criteria met: yes / no / not run      Pass / Fail / Unknown
Follow-up / owner decision:
```
