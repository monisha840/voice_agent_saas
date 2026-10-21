# Exotel authentication capabilities: what is documented vs unknown

Research date: 2026-10-14. Sources are Exotel's public docs; several are marked beta or are about a year old, so
re-check against your account. Every claim is classified **VERIFIED** (stated in a cited page) or
**UNKNOWN / ASSUMPTION** (docs silent, ambiguous, or contradictory). Page fetches were summarised by a tool, so
quotes should be re-read on the live page before they are relied on in a contract or audit.

Sources
* S1 Voicebot applet: https://docs.exotel.com/exotel-agentstream/voicebot-applet
* S2 Stream & Voicebot applet (support centre): https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet
* S3 Extension guide (beta, `CustomParameters`): https://developer.exotel.com/docs/agentstream/stream-voicebot-extension
* S4 WebSocket protocol: https://developer.exotel.com/docs/agentstream/websocket-protocol
* S5 Connect Voice AI API: https://developer.exotel.com/docs/agentstream/connect-voice-ai
* S6 Connect Voice AI with Flow: https://developer.exotel.com/docs/agentstream/connect-voice-ai-flow
* S7 SMS webhooks (IP wording): https://developer.exotel.com/docs/sms-support/sms-webhooks
* S8 WhatsApp webhooks (IP wording): https://developer.exotel.com/docs/whatsapp-support/webhooks
* S9 Getting started: https://developer.exotel.com/docs/agentstream/getting-started

## 1. Capability table

| # | Question | Finding | Status | Source |
|---|---|---|---|---|
| a1 | WS auth: Basic auth | Credentials written in the URL (`wss://<API_KEY>:<API_TOKEN>@host/path`) are sent by Exotel as `Authorization: Basic base64(user:pass)` on the upgrade. Not documented: whether arbitrary user/pass (not the account's API key/token) is accepted, though nothing suggests otherwise. | VERIFIED (mechanism); arbitrary values UNKNOWN | S1 |
| a2 | WS auth: IP allow-list | Documented: "whitelisting Exotel's outbound IP ranges"; ranges are obtained by asking Exotel (hello@exotel.com). Not published. | VERIFIED (option); ranges not public | S1, S2 |
| a3 | WS auth: custom headers | No documentation of configurable custom headers on the WS upgrade. | UNKNOWN (assume not available) | none |
| a4 | WS auth: signature / HMAC / JWT from Exotel | Nothing documented for the stream or for status callbacks. | UNKNOWN (assume none) | S1-S6 |
| a5 | Static egress IPs | Implied by a2 (a fixed range exists for whitelisting). Whether it covers the stream, webhooks and passthru identically is not stated. | UNKNOWN | S1 |
| b1 | Query params in the applet/StreamUrl reach our server | Documented as the way to pass up to **3** custom params, total query length **<= 256 chars**, format `?p1=v1&p2=v2`; Exotel then appends call details after them. Observed to work "reliably for straightforward key=value"; malformed concatenated keys seen with some names; Exotel advises testing on webhook.site. | VERIFIED (with caveats) | S1, S2 |
| b2 | Query string preserved on Calls/connect `StreamUrl` (our outbound path) | StreamUrl is a `ws://`/`wss://` URL, max **600 chars including query string**. Not stated whether the query is passed unchanged, nor whether the 3-param/256-char applet limit applies. Our `st` JWS + `token` is long (a JWS is typically 250-400 chars) and may exceed 256 if that limit applies. | UNKNOWN | S5 |
| c1 | `custom_parameters` in the `start` event | Appears under `start.custom_parameters` (example `{ "key1": "value1" }`). Source of the values is the query params configured on the applet URL ("picked from the URL configured in the Stream Applet"). | VERIFIED | S2, S4 |
| c2 | `custom_parameters` populated per call via `CustomField` | `CustomField` is "metadata on the call record (max 128 chars)" on Calls/connect, and "available to applets (e.g. Passthru)" in flow mode. No page links it to `start.custom_parameters`. | UNKNOWN (assume NOT echoed) | S5, S6 |
| c3 | Per-call `CustomParameters` request field | Beta extension guide describes a `CustomParameters` field (comma-separated `key=value`), delivered in the initial **`connected`** message (S3) while S4/S2 place `custom_parameters` in `start`. Not documented on the Calls/connect API page. Contradictory. | UNKNOWN / contradictory | S3, S4, S5 |
| c4 | Secrets in custom parameters | Exotel says do not pass secrets or tokens as custom parameters (plaintext in the WS message); use short-lived lookup tokens or session IDs. | VERIFIED | S3 |
| d1 | Status callback / passthru signature | No signature, HMAC or verification mechanism is documented on the Connect Voice AI pages. | UNKNOWN (assume none) | S5 |
| d2 | Status callback IP allow-list | No published list. SMS/WhatsApp webhook docs say to whitelist Exotel IP ranges and contact support; voice callbacks are not explicitly covered. | UNKNOWN for voice; ask support | S7, S8 |
| d3 | Does the StatusCallback payload include `CustomField` | Not stated. | UNKNOWN | S5 |
| e1 | Dynamic values / `${CallSid}` placeholders in the applet URL | Not documented. Do not assume templating. | UNKNOWN (assume NOT supported) | S1, S6 |
| e2 | Dynamic endpoint: applet URL is an `http(s)` URL that Exotel GETs, and that returns `{"url":"wss://..."}` | Documented. Exotel sends query params `CallSid, CallFrom, CallTo, Direction, Created, DialWhomNumber, From, To, CurrentTime` (after any configured custom params). Response must be HTTP 200, `application/json`, single key `url`. Example returns a per-session path (`/session/12345`). | VERIFIED | S1, S6 |
| e3 | Query string on the URL returned by the dynamic endpoint is preserved on the WS connect | Not stated explicitly. Path-based values are the documented example. | UNKNOWN (path: likely; query: test) | S1 |
| e4 | Authentication of Exotel's GET to the dynamic endpoint | Not documented (no signature stated; Basic/IP presumably apply as for other calls). | UNKNOWN | S1 |
| f1 | Published egress IPs | None published. Obtain from Exotel support. | VERIFIED that they are not public | S1, S7, S8 |
| g1 | Calls/connect API auth | HTTP Basic (API key / API token). | VERIFIED | S5 |

### What this changes in our existing docs
* `stream-tokens-and-dependencies.md` section 3 says "a per-call value cannot be embedded" in flow mode and "Exotel does not
  offer [a per-call token] for the applet". **Too strong.** The documented dynamic-endpoint method (e2) lets Exotel call an
  HTTPS endpoint of ours with `CallSid` and receive a wss URL we mint per call. That is a per-call credential path for
  flow/inbound calls, pending experiment E3/E4. Docs should say "no static-URL per-call value; dynamic endpoint untested".
* The in-code comment in `scripts/exotel-flow-url.ts` ("unconfirmed whether ?token= is passed through") is still accurate:
  S1/S2 document pass-through for the applet URL, but we have not confirmed it on our account.
* `telephony-auth.ts` already accepts Basic auth whose password is the secret, matching a1 (`wss://x:SECRET@host/...`).

## 2. Stream paths mapped to the strongest mechanism available

Strength order (best first): per-call token we mint (carried in a way Exotel proves it preserves) > Basic-auth header
(secret never in a URL query/log line) > IP allow-list at the edge (peer is Exotel, not which call) > shared secret in
query. Mechanisms combine; IP allow-list should be layered on every row.

| Path | Today | Strongest documented option | Needs experiment |
|---|---|---|---|
| Outbound StreamUrl mode (Calls/connect) | `?st=<JWS>` (+ `?token=` while `STREAM_ALLOW_STATIC_SECRET=true`) | Keep `st`; add IP allow-list. Shrink the URL: `st` only, `STREAM_ALLOW_STATIC_SECRET=false` after E1 passes. A short opaque id (lookup token, S3 recommendation) instead of a JWS if length is an issue (E2). | E1, E2 |
| Outbound flow mode (static Voicebot URL via `Url=`) | shared secret `?token=` | Switch the applet to Basic auth in the URL (a1) so the secret is not a query param, plus IP allow-list. Or dynamic endpoint (e2) returning a per-call `st`, with the call row looked up by `CallSid`. | E3, E4, E5 |
| Inbound webhook then stream | shared secret both legs | Same as flow mode: Basic auth + IP, or dynamic endpoint (Exotel passes `CallSid`, `To`, `From`; we register the call and mint the token in the same request, which removes the webhook-then-stream gap). | E3, E4 |
| Inbound direct stream | shared secret | Basic auth + IP; set `STREAM_INBOUND_DIRECT_ALLOWED=false` once the dynamic endpoint or webhook applet fronts every number. | E5 |
| Web call | user session | unchanged (not Exotel) | none |
| Status callback / passthru | shared secret `?token=` | No signature exists (d1). Use IP allow-list + shared secret + idempotent transitions (already). Prefer Basic-auth URL form on callbacks if Exotel accepts creds in the StatusCallback URL (UNKNOWN, E6). | E6 |

## 3. Recommended safe operating constraints (until experiments are done)

Edge / proxy
1. **IP allow-list**: ask Exotel (hello@exotel.com / account manager) for the outbound ranges for (i) the WS stream,
   (ii) status-callback and passthru HTTP, (iii) the dynamic-endpoint GET if used. Allow only those on
   `/api/telephony/exotel/*` at the reverse proxy or cloud firewall; everything else gets 403 before reaching Node.
   Record the list, its date and who supplied it; re-confirm quarterly (ranges can change).
2. **TLS**: terminate TLS 1.2+ at the proxy with a publicly trusted certificate; `wss://` only, redirect/deny `ws://`.
   Docs do not state Exotel's certificate validation behaviour (UNKNOWN); a Let's Encrypt or commercial chain is safest.
3. **Do not log query strings** at the proxy/CDN/load balancer for `/api/telephony/exotel/*` (access logs would hold
   `token`/`st`). The app already masks them; the edge must too. Prefer Basic-auth form for static URLs so the secret is
   in a header.
4. Keep the existing public-access guard (only `/health`, `/ready`, `/api/telephony/exotel/*` public).
5. Rate-limit the upgrade path per source IP and cap concurrent sockets.

App settings
* `STREAM_TOKEN_KEYS`: required in production; two keys during rotation.
* `STREAM_TOKEN_TTL_MS`: default 900000; lower to the p99 ring time + margin (it must exceed ringing).
* `STREAM_TOKEN_MAX_USES`: 3; lower to 2 if E7 shows Exotel never reconnects.
* `STREAM_ALLOW_STATIC_SECRET`: `true` only until E1 proves `st` arrives; then `false` for StreamUrl mode. It must stay
  `true` while flow/inbound paths use the shared secret (documented residual).
* `STREAM_ALLOWED_ACCOUNT_SIDS`: set (plus `EXOTEL_ACCOUNT_SID`); `start.account_sid` is cheap and rejects other accounts.
* `STREAM_INBOUND_DIRECT_ALLOWED=false` once every inbound number uses the webhook applet or dynamic endpoint.
* `STREAM_INBOUND_MAX_AGE_MS` / `STREAM_FLOW_MAX_AGE_MS`: tighten from 10/30 min to observed ring+answer time.
* `STREAM_STATIC_REQUIRE_PENDING_STATUS=true` only after E8 confirms the stream arrives before the "answered" callback.

Secret rotation (shared `EXOTEL_AGENTSTREAM_WEBHOOK_SECRET`; there is no overlap support today, so plan a window)
1. Generate a new 32+ byte random value. Choose URL-safe characters (avoid `@ : / ? #`, which break Basic-in-URL).
2. Low-traffic window. Update the secret in the app environment (optionally add a temporary second accepted value in
   code first: not implemented today; without it, expect failed callbacks during the switch).
3. Update every place Exotel holds it: Voicebot/Stream applet URL(s) in App Bazaar, StatusCallback URLs sent by the API
   (automatic after deploy), passthru applets. Use `pnpm exotel:flow-url --reveal` to print the URL on a private screen.
4. Place one test call per path (outbound StreamUrl, outbound flow, inbound). Check `access.stream_denied` events.
5. Revoke the old value; rotate again if the old URL appeared in a screenshot, ticket or chat.
Stream-token keys rotate separately (see section 2 of `stream-tokens-and-dependencies.md`).

## 4. Experiment checklist (test number, Exotel support)

Use a non-production ExoPhone and flow, a requestbin/webhook.site endpoint, and a staging API with
`STREAM_*` logging at debug. Record the date, request ids and Exotel's answer per item. Run each from a clean state.

* **E1 Query string on StreamUrl (outbound).** POST Calls/connect with `StreamUrl=wss://<staging>/api/telephony/exotel/media-stream?st=AAA&token=BBB`
  (short dummy values). Verify on the upgrade request that both parameters arrive exactly (`req.query`). Repeat with a real
  JWS (about 300 chars) and with `StreamUrl` under 600 chars total. Pass = both arrive intact. Fail/trunc = shorten (E2).
* **E2 Length limits.** Repeat E1 with 1 param of 100, 255, 257, 400 chars; with 4 params; with URL-encoded `%2B`/`=`/`.`
  characters (JWS is base64url, `.` separated). Record where truncation or the "malformed key" behaviour (S2) starts.
* **E3 Applet static URL pass-through.** In a flow, set the Voicebot applet URL to
  `wss://<staging>/...?token=XYZ&a=1`. Place an inbound call and an outbound call (`Url=` flow). Confirm `req.query`
  and `start.custom_parameters` on our side. Note whether the same params appear in both (S1 says appended call details come after).
* **E4 Dynamic endpoint.** Set the applet URL to `https://<staging>/exotel/ws-url`. Log the full GET (method, headers,
  all query names, source IP, `Authorization` if any). Return `{"url":"wss://<staging>/api/telephony/exotel/media-stream?st=<per-call>"}` and then,
  separately, a path form `/media-stream/<per-call>`. Pass = which of query / path arrives. Also test: response time budget
  (how long Exotel waits), non-200 behaviour (does the call drop?), redirects.
* **E5 Basic-auth URL.** Set applet URL to `wss://anyuser:<secret>@<staging>/api/telephony/exotel/media-stream`. Confirm the upgrade
  has `Authorization: Basic ...` and `telephony-auth.ts` accepts it. Then try a user/password that are NOT the account API key/token
  (this is the UNKNOWN in a1). Test a secret with `%`-encoded characters.
* **E6 Callback auth.** Send `StatusCallback=https://user:secret@<staging>/...` and a plain URL; log the headers Exotel
  sends. Look for any signature header (`X-Exotel-*`). Confirm the callback source IPs match the list from support.
  Check whether `CustomField` is echoed in the callback body.
* **E7 Reconnects.** Drop the socket mid-call from our side and during ringing; count Exotel reconnects and whether it
  reuses the same URL (informs `STREAM_TOKEN_MAX_USES`).
* **E8 Ordering.** Timestamp the "answered" callback vs the WS upgrade across 20 calls (informs
  `STREAM_STATIC_REQUIRE_PENDING_STATUS`).
* **E9 `CustomField` / `CustomParameters` echo.** Calls/connect with `CustomField=probe123` and, separately, `CustomParameters=a=b`.
  Check `connected` and `start` frames for either value (resolves c2/c3 and the S3 vs S4 contradiction).
* **E10 Source IP capture.** Log `req.ip` (behind the proxy's trusted hop) for the upgrade, callbacks and dynamic GET over
  20+ calls from both India and Singapore subdomains if used; compare with the support-provided ranges.

Questions for Exotel support (send in one ticket, ask for written replies)
1. Outbound IP ranges (CIDR) for WSS streams, voice status callbacks/passthru, and the dynamic Voicebot URL GET; change notification policy.
2. Is the query string of `StreamUrl` on Calls/connect, and of the URL returned by the dynamic endpoint, passed unchanged? Do the 3-param/256-char limits apply?
3. Is `CustomField` or any per-call field returned in `start.custom_parameters`? Is `CustomParameters` a supported Calls/connect field?
4. Does the Voicebot applet URL support placeholders for call variables? Is the dynamic-endpoint GET authenticated or signed?
5. Do status callbacks or passthru requests carry a signature/HMAC, and can credentials be placed in the callback URL?
6. Certificate requirements for `wss://` (CA chain, TLS versions) and any retry/reconnect semantics.

## 5. Residual risk statement (honest summary)

Exotel documents only: Basic-auth-in-URL, IP allow-listing (ranges on request), URL query pass-through for static applet
URLs, and a dynamic HTTP endpoint that supplies `CallSid`. It documents **no** signature for the stream or callbacks.
Therefore for flow/inbound paths the peer proves only "knows the secret" (and, with an edge allow-list, "comes from
Exotel's range"). Closing the per-call gap requires the dynamic-endpoint experiment (E3/E4); until it passes, the
compensating controls in `stream-tokens-and-dependencies.md` section 3 stay as the defence, with the edge IP allow-list
added as the most valuable single control.
