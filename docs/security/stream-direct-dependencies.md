# Direct (static-secret, unregistered call_sid) stream dependencies

Scope: everything that opens a media-stream WebSocket (`GET /api/telephony/exotel/media-stream`, `GET /api/web-call/stream`)
and what happens to it when `STREAM_INBOUND_DIRECT_ALLOWED=false`. Derived from code (`security/stream-auth.ts`,
`websocket/exotel-media-stream.handler.ts` `resolveCall`/`assertStreamMayAttach`, `modules/calls/*.routes.ts`,
`scripts/exotel-preflight.ts`, `simulator/call-simulator.ts`, `adapters/telephony/exotel.provider.ts`) and verified on OUR
side by `apps/api/src/security/stream-direct-disabled.e2e.test.ts`. **Nothing here was exercised against real Exotel.**

## 1. What the flag does (and does not do)

`STREAM_INBOUND_DIRECT_ALLOWED` (default `true`) only affects one decision in `resolveCall`: a stream that authenticated
with the shared secret, whose `start.call_sid` matches **no existing call row**, and whose `start.to` is a mapped number.

| Flag | Behaviour for that stream |
|---|---|
| `true` (default) | `startInboundCall` creates an inbound call from the stream's own `start.to`/`start.from`, then attaches. |
| `false` | No call is created. The handler waits up to 10 x 300 ms (about 3 s) for the call row to appear (outbound link race), then refuses with `StreamRejectedError("unregistered_call_sid")`: WebSocket close `1008 "unauthorized"`, a `security_events` row `access.stream_denied` with `metadata.reason="unregistered_call_sid"`, and the log line `media-stream: stream refused`. It is also counted in `stream_auth_denied_total{reason="unregistered_call_sid"}` (handler-side refusals were not counted before this workstream, so the stream-denial alert could not see them). |

It does **not** change: stream tokens (`st`), grants (`g`), `STREAM_ALLOW_STATIC_SECRET`, account allow-list, age checks, one-stream-per-call,
the inbound/status-callback webhooks, or the web call. A static-secret stream for a call row that already exists is
unaffected (it is "registered").

## 2. Flow table

"Registered" = a `calls` row with `provider_call_id = start.call_sid` exists before the stream's `start` event (or appears
within about 3 s).

| # | Flow | Credential on the stream | Who registers the call_sid | Depends on direct? | With `STREAM_INBOUND_DIRECT_ALLOWED=false` | Test |
|---|---|---|---|---|---|---|
| 1 | Inbound number -> Voicebot applet with a **static** `wss://...?token=` URL and **no** inbound webhook/Passthru applet before it | shared secret | nobody (the stream creates the call from `start.to`) | **YES** | **REFUSED** `unregistered_call_sid` (1008, no call created). Fix: put an HTTP applet that calls `/api/telephony/exotel/inbound` ahead of the Voicebot applet, or switch the applet to the dynamic endpoint (flow 3) | `direct inbound stream ...`, `static Voicebot applet URL on an inbound number ...` |
| 2 | Inbound number -> `inbound` webhook applet (Passthru/HTTP, `?token=`) -> Voicebot static URL | shared secret on both legs | `POST|GET /inbound` (`startInboundCall`, idempotent on CallSid) | no | works | `inbound: webhook registers the call ...` |
| 3 | Inbound (or outbound-flow) -> Voicebot **dynamic endpoint** `/stream-url` -> `?g=` grant | grant `g` only (no secret on the stream) | `/stream-url` (inbound: registers; outbound: looks up, never creates) | no | works | `grant path ...` |
| 4 | API-initiated outbound, StreamUrl mode (`ExotelProvider.initiateCall`, no `EXOTEL_FLOW_APP_ID`) | `st` per-call JWS (+ `token` while `STREAM_ALLOW_STATIC_SECRET=true`) | the API created the row before dialing; token names the call, so even an unlinked `provider_call_id` works | no | works | `outbound API (StreamUrl mode) ...` |
| 5 | API-initiated outbound, **flow mode** (`EXOTEL_FLOW_APP_ID` set; static Voicebot URL in the flow) | shared secret | the API (row exists; `provider_call_id` is linked right after Calls/connect returns; the stream waits up to about 3 s for the link) | no (it is registered), but it is a static-secret stream | works | `outbound flow mode ...`, `... link race ...` |
| 6 | Local simulator / `MOCK` telephony / `demo-call` script (`internalCallId` + `token` if a secret is set) | shared secret or none (`TELEPHONY_PROVIDER=mock` only) | the API (`placeCall` -> mock provider links the id) | no | works | `local simulator / mock provider ...` |
| 7 | `pnpm exotel:preflight` step 4 | shared secret | **was nobody** (synthetic `preflight-<ts>` call_sid + `to`) -> this script was a direct-flow user; **changed in this workstream** to call `/inbound` first | was YES | works after the change; before it, it would FAIL under `false` | not covered by a unit test (needs a live URL); logic equals flows 1 vs 2 |
| 8 | Browser web call (`/api/calls/web` + `/api/web-call/stream`) | user session cookie + Origin | `POST /api/calls/web` creates the row; handler gets `internalCallId` from the server | no | works | `browser web call ...` |
| 9 | `STREAM_REQUIRE_GRANT=true` (opt-in) | grant required | as flow 3 | n/a (supersedes: static-only streams are refused as `grant_required` before `resolveCall`) | works; static-only refused | `STREAM_REQUIRE_GRANT=true together with direct=false ...` |
| 10 | Stream with no `call_sid` and no `internalCallId` | any | n/a | n/a | closed without audio as an init failure (code 1005, error log), not a `1008` security event. Same with the flag `true` | `a stream with no call_sid ...` |
| 11 | Status callbacks, `/inbound`, `/stream-url` HTTP endpoints | `?token=` / Basic | n/a | not streams | unaffected | existing suites |

Contrast test: `with STREAM_INBOUND_DIRECT_ALLOWED=true a direct inbound stream creates the call and attaches`.

### What cannot be inferred from code (must be checked in the Exotel dashboard)

* Which inbound ExoPhone flows currently end in a bare Voicebot applet (flow 1). `exotel-auth-capabilities.md` and
  `.env.example` describe the inbound webhook applet, but the dashboard is the only source of truth. **Owner action:**
  list every number/flow and tick flow 1 vs 2 vs 3 before enabling the flag.
* Whether Exotel sends `to` as the ExoPhone in `start` for inbound (the repo assumes so; unchanged by this flag).

## 3. Recommended production configuration

Apply per environment only after the dashboard inventory above shows **no** flow-1 number. Items marked (staging) need the
experiments in `exotel-staging-test-plan.md` first.

```
# Stream authentication
STREAM_TOKEN_KEYS=<kid>:<base64 32+ bytes>          # required in production with Exotel (two keys during rotation)
STREAM_INBOUND_DIRECT_ALLOWED=false                  # this document
STREAM_ALLOWED_ACCOUNT_SIDS=<your Exotel account sid(s)>   # plus EXOTEL_ACCOUNT_SID
STREAM_INBOUND_MAX_AGE_MS=120000                     # tighten to observed ring+answer time (default 600000)
STREAM_FLOW_MAX_AGE_MS=300000                        # tighten likewise (default 1800000)
STREAM_TOKEN_TTL_MS=300000                           # must exceed p99 ring time (default 900000)
STREAM_TOKEN_MAX_USES=3
STREAM_GRANT_TTL_MS=120000                           # (staging) only matters if the dynamic endpoint is used
STREAM_GRANT_MAX_USES=3                              # (staging)

# Keep unchanged until the staging plan passes
STREAM_REQUIRE_GRANT=false                           # NEVER enabled automatically; opt-in after E3/E4 pass
STREAM_ALLOW_STATIC_SECRET=true                      # flow mode and inbound still use the shared secret
STREAM_STATIC_REQUIRE_PENDING_STATUS=false           # (staging, E8) only after "answered" vs upgrade ordering is measured

# Edge (not application env): IP allow-list for /api/telephony/exotel/*, no query-string access logs, TLS 1.2+.
```

### Which flows break if this block is applied

| Setting | Breaks / refuses | Does not break |
|---|---|---|
| `STREAM_INBOUND_DIRECT_ALLOWED=false` | flow 1 (inbound number -> bare Voicebot static URL, no webhook applet); preflight script versions before this change | flows 2-6, 8 |
| `STREAM_ALLOWED_ACCOUNT_SIDS` set | any stream whose `start.account_sid` is absent or different (including `test-account` style fixtures and a sandbox/sub-account not listed) | all streams from the listed account(s). Applies to token, grant and static streams |
| short `STREAM_INBOUND_MAX_AGE_MS` / `STREAM_FLOW_MAX_AGE_MS` | a **static-secret** stream that connects later than the limit after the call row was created (long ringing, slow flow greeting, reconnect after the window). Token and grant streams are not age-checked | on-time streams |
| short `STREAM_TOKEN_TTL_MS` | an outbound call that rings longer than the TTL: the `st` token expires before Exotel connects -> `token_expired` | calls answered within the TTL |
| `STREAM_REQUIRE_GRANT=true` (not in the block; listed for completeness) | every stream carrying neither `g` nor `st`: flows 1, 2 and 5 (unless those numbers/flows are moved to the dynamic endpoint) | grant streams and `st` streams (flow 3, flow 4) |

The `grant_required` check in `stream-auth.ts` runs after the `g` and `st` branches, so `st` streams are unaffected.

### Residual after applying it

Flows 2 and 5 still authenticate with the shared secret and `call_sid`: anyone holding the secret and a live, not yet
streamed `call_sid` can attach inside the age window. `false` removes only the ability to **create** calls from a bare
stream. The per-call fix (grants) is unverified against real Exotel; see `exotel-staging-test-plan.md`.

### Rollback

Set `STREAM_INBOUND_DIRECT_ALLOWED=true` (or unset it) and restart; no data migration is involved. A refused stream
creates nothing, so there is nothing to clean up.
