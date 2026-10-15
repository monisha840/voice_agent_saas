# Per-call stream authentication, telephony integration, and dependency posture

## 1. Two independent mechanisms (what each one proves)

| Mechanism | Used on | Proves | Does NOT prove |
|---|---|---|---|
| **Shared webhook secret** (`EXOTEL_AGENTSTREAM_WEBHOOK_SECRET`, `?token=` or Basic auth, constant-time compare) | status-callback, inbound webhook; and the media stream **only** as the fallback below | the peer knows a deployment-wide secret | which call it may touch; that it is Exotel |
| **Per-call stream token** (`?st=`, HS256 JWS via `jose`) | outbound media stream (StreamUrl mode) | this URL was minted by our API for **this call** in **this organization**, within its window and use budget | that the peer is Exotel (a bearer credential) |

A presented `st` is the *only* credential considered: an invalid token is never rescued by a correct shared secret.
Provider-webhook verification and stream-token verification are separate code paths
(`security/telephony-auth.ts` vs `security/stream-token.ts` + `security/stream-auth.ts`).

## 2. Token lifecycle

* **Issue**: when the outbound call is created (`ExotelProvider.initiateCall`), after the call row exists.
  Claims: `iss=voice-engine`, `aud=voice-engine:media-stream`, `sub=<call id>`, `org=<organization id>`,
  `prv=exotel`, random `jti`, `iat`/`nbf`/`exp`; header `kid`.
* **TTL**: `STREAM_TOKEN_TTL_MS` (default 15 min, minimum 30 s) — must exceed the ring time.
* **Verify (before any audio or event)**: signature + algorithm allow-list (HS256 only), issuer, audience,
  expiry/not-before (5 s skew), claim shapes (UUIDs), type marker. Failure → WebSocket closed `1008`, an
  `access.stream_denied` security event with a *reason only* (never the token).
* **Use budget (replay)**: each accepted connection increments `stream_token_uses.uses` (PostgreSQL upsert, shared
  across instances). More than `STREAM_TOKEN_MAX_USES` (default 3: legitimate provider reconnects) → refused.
  Not single-use on purpose, because provider reconnects are legitimate.
* **Binding at attach time** (every stream, token or not): the token's call and organization must equal the call
  record found; the provider's `call_sid` must equal the call's recorded provider id when both are known; the call
  must not be finished; **one stream per call** (atomic in-process claim, then a shared PostgreSQL claim, see 3b) so a second connection cannot hijack or
  eavesdrop a live call.
* **Rotation**: `STREAM_TOKEN_KEYS="<kid>:<base64 32+ bytes>[,<kid>:<base64>...]"`. First key signs, all verify.
  Rotate: prepend the new key → deploy → wait one TTL → remove the old key. Keys never appear in logs.
  Generate: `node -e "console.log('k'+Date.now()+':'+require('crypto').randomBytes(32).toString('base64'))"`.
* **Failure behaviour**: any verification error denies; there is no "log and allow". With no keys configured a
  development process uses a throw-away key (single instance only); **production with Exotel refuses to start
  without `STREAM_TOKEN_KEYS`**.
* **Leakage**: `?st=` and `?token=` are masked by the request-log serializer (`redactUrl`) and by the structured
  logger's string scrubber; errors carry only a reason code.

## 3. Telephony integration and its limits

* **StreamUrl mode (API-initiated outbound)**: full protection above. The URL contains only `st` when
  `STREAM_ALLOW_STATIC_SECRET=false`; with it `true` (default) the shared secret is repeated as a compatibility
  fallback in case a peer drops the token.
* **Flow mode / inbound**: Exotel's Voicebot applet holds one static `wss://` URL configured once in the dashboard,
  so a per-call value **cannot be embedded in a static URL** (a dynamic endpoint can supply one: see section 3c,
  opt-in and UNVERIFIED against real Exotel). With the static URL these streams authenticate with the shared secret only
  (`STREAM_ALLOW_STATIC_SECRET=true`). A shared secret never proves tenant ownership; the tenant always comes from
  the database record the stream resolves to. Compensating controls (enforced in the stream handler, see 3a):
  the call is resolved from the provider's own `start.call_sid` (a URL `internalCallId` is ignored unless
  `TELEPHONY_PROVIDER=mock`); the record must be live and young (`STREAM_INBOUND_MAX_AGE_MS`, default 10 min;
  `STREAM_FLOW_MAX_AGE_MS`, default 30 min), and with `STREAM_STATIC_REQUIRE_PENDING_STATUS=true` still
  `initiating`/`ringing` (off by default: Exotel's "answered" callback can reach us before the stream, so strict
  mode may refuse legitimate flows; enable after verifying on real traffic); an unknown `call_sid` creates nothing
  when `STREAM_INBOUND_DIRECT_ALLOWED=false`; `start.account_sid` must be in `STREAM_ALLOWED_ACCOUNT_SIDS` (plus
  `EXOTEL_ACCOUNT_SID`) when that list is set; one stream per call across instances (3b); effects are confined to
  that call's organization by RLS.
  **Residual risk (cannot be removed with Exotel's applet)**: anyone holding the shared secret AND knowing the
  `call_sid` of a live call that has not streamed yet can attach to it inside that window. `call_sid` values are not
  secret (they appear in provider callbacks and dashboards). Mitigations: secret rotation, IP allow-listing of
  Exotel egress at the edge, `STREAM_INBOUND_DIRECT_ALLOWED=false`, short max ages, the account allow-list. A
  provider-signed per-call token is the only complete fix and Exotel does not offer one for the applet.

### 3a. Every stream path

| Path | Credential | What binds tenant / call | Residual risk |
|---|---|---|---|
| Outbound, StreamUrl mode (API `placeCall`) | per-call `?st=` JWS; with `STREAM_ALLOW_STATIC_SECRET=true` the secret is also in the URL, but a presented bad token is never rescued by it | token `sub`+`org` must equal the DB call record; `call_sid` must equal the recorded provider id; call not finished; account allow-list; shared claim | bearer secret in a URL until it expires (`STREAM_TOKEN_TTL_MS`) or hits `STREAM_TOKEN_MAX_USES`; does not prove the peer is Exotel |
| Outbound, flow mode (static Voicebot URL) | shared secret only | tenant from the call row found by `start.call_sid`; row live and younger than `STREAM_FLOW_MAX_AGE_MS`; account allow-list; shared claim | secret holder who knows a waiting `call_sid` can attach inside the window |
| Inbound, webhook then stream | webhook: shared secret; stream: shared secret | the webhook resolves dialed number -> agent/org and registers the call (idempotent on `CallSid`); the stream must find that exact `call_sid` record, live, younger than `STREAM_INBOUND_MAX_AGE_MS`; the start event's `to` is never used to choose a tenant once a record exists | as flow mode. The webhook's call row IS the server-side registration; a separate nonce cannot ride a static URL, so it would add no proof |
| Inbound, direct stream (no webhook) | shared secret only | with `STREAM_INBOUND_DIRECT_ALLOWED=true` (default, back-compat) `start.to` routes and creates the call; with `false` an unknown `call_sid` is refused and creates nothing | enabled by default: a secret holder can create inbound calls (the owning org's limits apply). Turn off once every inbound number runs the webhook applet first |
| Web call (`/api/web-calls/...`) | logged-in user session | `internalCallId` owned by the user's organization; hints carry no `auth`, so telephony-only checks (account allow-list, ages) do not apply | ordinary web-session risk |

### 3c. Opt-in per-call grants via the Voicebot dynamic endpoint (UNVERIFIED against real Exotel)

**Status: implemented and tested on our side only. Nothing here has been exercised against real Exotel, and nothing
changes unless you switch the applet and/or set `STREAM_REQUIRE_GRANT=true`.**

Exotel documents a Voicebot "dynamic endpoint": instead of a static `wss://` URL the applet holds an `http(s)` URL that
Exotel GETs per call (query: `CallSid, CallFrom, CallTo, Direction, Created, DialWhomNumber, From, To, CurrentTime`)
and expects `200 {"url": "wss://..."}`. We use that to hand each call its own credential.

* **Endpoint**: `GET|POST /api/telephony/exotel/stream-url`. Authenticated by the existing webhook secret (`?token=`
  or Basic); anything else is `401` (fail closed). It resolves the call like the inbound webhook (known `CallSid`
  first; for an inbound `Direction` it registers the call by dialed number via `startInboundCall`; for an
  `outbound*` Direction it only looks the call up, with a short wait for the `CallSid` link, and never creates one;
  finished calls are `409`). It returns `{"url": "<wss base>/api/telephony/exotel/media-stream?g=<grant>"}`.
  The base is `EXOTEL_WEBHOOK_BASE_URL` (https -> wss). The returned URL never contains the shared secret.
* **Grant**: 128 random bits, base64url, 22 characters (the signed `st` JWT is far too long for Exotel's 256-character
  applet URL limit; the whole returned URL is about 100 characters). Table `stream_grants` stores only
  `sha256(grant)`, `call_id`, `provider_call_id`, `expires_at`, `uses` (migration 0021). It has no `organization_id`
  and no RLS by design: it holds no tenant content, the organization is always read from the call record, and a
  tenant column would force a SECURITY DEFINER resolver for the pre-tenant lookup for no gain.
* **Stream auth** (`security/stream-auth.ts`): a presented `g` is the ONLY credential considered (a bad grant is never
  rescued by `token`). One atomic statement checks hash, expiry and `uses < STREAM_GRANT_MAX_USES` (default 3) and
  counts the use across instances. The call record named by the grant must carry the same provider call id, and
  the handler then requires the start event's `call_sid` to equal it (a missing or different `call_sid` is
  refused), so a grant cannot be moved to another call or tenant. One-stream-per-call (3b) still applies.
  The janitor deletes expired grants.
* **Config**: `STREAM_GRANT_TTL_MS` (default 10 min), `STREAM_GRANT_MAX_USES` (default 3),
  `STREAM_REQUIRE_GRANT` (default `false`; when `true` a stream with no grant, i.e. static-secret-only, is refused
  as `grant_required`. This is the strongest mode and only safe once EVERY number/flow uses the dynamic endpoint).
* **Exotel dashboard steps** (do on a test number first):
  1. In the flow/App Bazaar, set the Voicebot applet URL to
     `https://<api-host>/api/telephony/exotel/stream-url?token=<EXOTEL_AGENTSTREAM_WEBHOOK_SECRET>` (one custom param,
     within the 3-param / 256-char limit), or use Basic auth in the URL if the applet supports it.
  2. Keep `STREAM_REQUIRE_GRANT=false`. Place an inbound and an outbound-flow test call; confirm in logs that the
     media stream connected with `g=` (the secret should not be needed on the stream) and the call attached.
  3. Only after both pass and the static path shows no traffic, set `STREAM_REQUIRE_GRANT=true`, and optionally
     `STREAM_INBOUND_DIRECT_ALLOWED=false`.
  4. Rollback: set `STREAM_REQUIRE_GRANT=false` and point the applet back at the static `wss://` URL.
* **UNVERIFIED assumptions** (experiment ids from `docs/security/exotel-auth-capabilities.md`):
  * E3: the query string (`?g=...`) of the URL returned by the dynamic endpoint is preserved on Exotel's WS connect.
    The documented example is path-based. If the query is dropped, the grant never arrives and, with
    `STREAM_REQUIRE_GRANT=true`, every call is refused. A path-embedded grant would need a code change.
  * E4: whether Exotel sends our `token` parameter (or Basic credentials) on the endpoint GET, i.e. whether the GET
    can be authenticated at all, and the endpoint's source IPs. Until verified, the endpoint is reachable only by
    someone who knows the secret; if Exotel cannot send it, the endpoint cannot be used.
  * E3/E5: the applet URL limits (3 params / 256 characters) and whether `Direction` values match
    (`inbound` vs `outbound-api` / `outbound-dial`); we treat any value starting with `outbound` as outbound.
  * Latency: Exotel waits for this GET before connecting audio; the outbound lookup may wait up to about 3 seconds.
* **Residual risks**: the secret is still the credential for the endpoint (a holder can mint a grant for any live
  `CallSid` it knows, so this narrows rather than removes the shared-secret exposure); the grant travels in a URL
  (masked in our logs, but Exotel's own logs are out of our control); a leaked grant works for up to
  `STREAM_GRANT_MAX_USES` connections until expiry, but only for its single call and only when its `call_sid` matches.

### 3b. Cross-instance stream claim

`lifecycle.claimStream` remains the synchronous in-process fast path. When it succeeds the handler claims the call in
PostgreSQL (`stream_claims`, migration 0017): `INSERT .. ON CONFLICT (call_id) DO UPDATE .. WHERE heartbeat_at <
now() - STREAM_CLAIM_STALE_MS`, so two instances cannot both win. A live stream refreshes `heartbeat_at` every
`STREAM_CLAIM_HEARTBEAT_MS` (default 10 s; stale after `STREAM_CLAIM_STALE_MS`, default 30 s) and deletes only its
own row on close. A crashed instance's claim goes stale and the next connection takes it over; a stalled holder that
finds its claim taken over closes its socket without ending the call. If the database cannot be reached the stream
is refused (fail closed). Rows stale for a day are deleted by the security janitor.

* Provider webhook **signature/timestamp replay protection** is not available from Exotel (shared secret only), so
  callbacks rely on idempotent state transitions (tested: duplicate and out-of-order callbacks).

## 4. Dependency upgrades performed

| Package | From → To | Why / breaking changes handled |
|---|---|---|
| `fastify` | 4.29.1 → 5.12.7 | 10 advisories (GHSA-jx2c-rxcm-jvmq, -667r-xxjv-c9mm, -p68q-wchp-6fh7 auth bypass via malformed URLs, -hwr6-493r-vm6h, -9q9j-q6p8-xq58, -444r-cwp2-x5xf, -w2qp-rph6-63g4, -4mh8-r7rc-xpvc, -mrq3-vjjr-p77c); `trustProxy` hop count expressed as predicate, error handler `unknown`, websocket errorHandler to keep `1009` close code |
| `@fastify/cookie|cors|formbody|rate-limit|websocket` | → 11 / 11 / 8 / 10 / 11 | required by Fastify 5 |
| `find-my-way` | 8.2.2 → 9.10.0 (via fastify) | GHSA-c96f-x56v-gq3h |
| `drizzle-orm` / `drizzle-kit` | 0.33 → 0.45.4 / 0.24 → 0.31.11 | GHSA-gpj5-g38j-94v9 (SQL injection in identifier escaping); driver now passes `{prepare}` to `unsafe` and wraps errors in `DrizzleQueryError` (scoped client forwards options; `db/pg-error.ts` unwraps `cause`) |
| `next` / `react` / `react-dom` | 14.2.35 → 15.5.27 / 18 → 19.3 | 2 critical (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) + 8 high + moderates, all fixed ≥15.5.24; async `cookies()`/`params`/`searchParams` migrated |
| `postcss` (via `next`) | 8.4.31 → ^8.5.30 (pnpm override) | GHSA-qx2v-qp2m-jg93, -6g55-p6wh-862q, -r28c-9q8g-f849, -fxqj-rqcc-2cmp; verified by `next build` |
| `vitest` (dev) | 2.1 → 4.1.11 | GHSA-5xrq-8626-4rwp (critical), tinypool GHSA-5gmw-xhrv-c9v3/-85c8-ppgw-ccpr (critical), vite GHSA-fx2h-pf6j-xcff |
| `jose` | new, ^6.2.12 | JWS signing/verification for stream tokens |

`pnpm audit --prod`: **0 advisories**. Remaining (`pnpm audit`, dev-only, not shipped):

| Package | Advisory | Path | Exposure / reason unresolved |
|---|---|---|---|
| `braces` ≤3.0.3 (high) | GHSA-vfj7-8cjw-p6xm (stack exhaustion on pathological glob) | `@typescript-eslint/*` → `micromatch` | no patched version exists; lint-time only on our own globs |
| `esbuild` (moderate) | GHSA-67mh-4wv8-2f99 (dev server CORS) | `drizzle-kit` → `@esbuild-kit` | dev dependency; we never run an esbuild dev server |
| `postcss-selector-parser` (moderate) | GHSA-rj75-hqrm-r3gf | tailwind (build) | build-time on our own CSS |

## 5. Rollback

* Stream tokens: set `STREAM_ALLOW_STATIC_SECRET=true` (default) — the old shared-secret behaviour keeps working
  for any peer that does not carry `st`. Removing keys is refused in production with Exotel.
* Migration `0017` only adds `stream_claims`; relax the new checks with `STREAM_INBOUND_DIRECT_ALLOWED=true`, an empty `STREAM_ALLOWED_ACCOUNT_SIDS` and larger `STREAM_*_MAX_AGE_MS`.
* Migration `0014` only adds `stream_token_uses`; dropping it is safe once no process issues tokens.
* Dependency upgrades roll back by reverting `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`; the code
  changes (`db/pg-error.ts`, scoped-client options pass-through) are compatible with the old versions.
