# Rate limiting

All rate-limit and throttle counters are stored in PostgreSQL and shared by every API instance. No Redis, no
new network dependency, and no per-key state in process memory.

Code: `apps/api/src/security/rate-limits.ts` (limiter), `apps/api/src/auth/login-throttle.ts` (login/MFA lockouts),
`apps/api/src/db/repositories/security.repository.ts` (`rateLimitBucketsRepository`, `authThrottleRepository`),
migration `0018_rate_limit_buckets.sql` (0016 is unused in this repo's journal; the number was assigned by drizzle).

## Inventory

| Limiter | Scope / key | Limit | Store | Failure mode on store error |
|---|---|---|---|---|
| Global per-IP hook (`globalRateLimitHook`, onRequest, before the login gate) | `req.ip`, window length is part of the key | `RATE_LIMIT_API_MAX` (300) per `RATE_LIMIT_API_WINDOW_MS` (60 s) | `rate_limit_buckets` | open (default) / closed via `RATE_LIMIT_FAIL_MODE` |
| `POST /api/auth/login` route limit | `req.ip` + lower-cased email (preHandler) | 10 / 15 min | `rate_limit_buckets` | closed (503) |
| `POST /api/auth/accept-invite` | `req.ip` | 10 / 15 min | `rate_limit_buckets` | closed (503) |
| Sensitive account routes (sessions revoke, reauthenticate, change-password, MFA enroll/confirm/recovery-codes/disable) | `acct:<userId>`, one budget per route | 15 / 15 min | `rate_limit_buckets` | closed (503) |
| `POST /api/auth/mfa/verify` | `mfa:<userId>` | 20 / 15 min | `rate_limit_buckets` | closed (503) |
| Per-organization call initiation (`callRateLimitPreHandler`: `/api/calls`, `/api/calls/web`, `/api/leads/:id/call`) | `organizationId` | `RATE_LIMIT_CALLS_PER_ORG_MAX` (10) per `..._WINDOW_MS` (60 s) | `rate_limit_buckets` | follows `RATE_LIMIT_FAIL_MODE` |
| Demo property API (`enforceDemoApiRateLimit`, under the exempt Exotel prefix) | `req.ip` | 60 / min | `rate_limit_buckets` | follows `RATE_LIMIT_FAIL_MODE` |
| Login throttle (`loginThrottle`) | SHA-256 of account+IP pair, IP, account | escalating, bounded lock (see file header) | `auth_throttle` | existing behaviour (request errors) |
| MFA second-factor attempts (`mfa.service`) | same `loginThrottle`, keyed by user | same | `auth_throttle` | existing behaviour |

Before this change the first six rows were in process memory (a private sliding-window map plus the
`@fastify/rate-limit` in-memory store), so N instances allowed N times the limit and a restart reset everything.
`@fastify/rate-limit` is no longer registered (the dependency can be removed from `package.json`).

Never throttled: `/health`, `/ready`, `/api/telephony/exotel/*` (Exotel retries from few IPs), and `OPTIONS`
requests for the global hook.

Note the stricter per-pair login throttle (5 failures) normally trips before the route limit (10 attempts).

## Implementation

Table `rate_limit_buckets(key varchar(64) pk, window_start timestamptz, count int)`, no RLS (operational table,
no tenant data; granted SELECT/INSERT/UPDATE/DELETE to `voice_app`). `key = sha256("rl:<scope>|<identifier>")`, so
no IP, email or user id is stored.

One statement per check, using the database clock (no instance clock sync needed):

```sql
insert into rate_limit_buckets as b (key, window_start, count) values ($1, now(), 1)
on conflict (key) do update set
  count = case when b.window_start <= now() - $w then 1 else least(b.count + 1, 1000000000) end,
  window_start = case when b.window_start <= now() - $w then now() else b.window_start end
returning count, <seconds until window end>
```

- Fixed window that starts at the first hit; a client may burst up to 2x the limit across a boundary.
- Blocked requests are counted too (a flood stays blocked; the count saturates, it cannot overflow).
- Cost: one indexed single-row upsert per limited request (`/health`, `/ready`, Exotel: none). A request to a
  login route costs two (global + route).
- Cleanup: the security janitor (`purgeExpiredRateLimitBuckets`) deletes buckets older than
  `max(1 h, 2 x configured windows)` in batches of 1000 (at most 20 batches per tick, every 10 minutes).
- 429 response is unchanged: `{ "error": "Too many requests. Try again in N seconds." }` with `Retry-After`.
  The per-org call limit keeps its `Call limit reached ...` message.
- The global IP key includes the window length, so changing `RATE_LIMIT_API_WINDOW_MS` starts a fresh bucket.

## Failure behaviour

| Route class | Store error | Response |
|---|---|---|
| Login, accept-invite, MFA verify, sensitive account routes | FAIL CLOSED, always | 503 `{ error, code: "RATE_LIMIT_UNAVAILABLE" }` + `Retry-After: 5` |
| Global per-IP hook, per-org call limit, demo API | FAIL OPEN by default; `RATE_LIMIT_FAIL_MODE=closed` makes them 503 too | request served unlimited / 503 |

Every store error increments an in-process counter (`getRateLimitBackendErrorCount()`) and is logged at error
level with `scope`, `failMode`, the behaviour taken and the totals; the log line is rate-limited to once per
30 s (suppressed occurrences are counted in the next line). Alert on the log message
`rate-limit: counter store unavailable`. While the store is failing open, global per-IP protection is OFF; the
auth/sensitive limits and the PostgreSQL login throttle (which needs the same database) are fail closed, so
credential guessing is not enabled by an outage. If the whole database is down, most routes fail anyway.

## Proxy trust, client IP and spoofing

- `req.ip` is the only client identity used by any limiter. Fastify derives it from the socket address unless
  `TRUST_PROXY` is set, in which case it walks `X-Forwarded-For` from the right.
- `TRUST_PROXY` forms: `false`/unset (default; `X-Forwarded-For` ignored, `req.ip` is the direct peer);
  `true` (trust every hop: only safe if the API is unreachable except through your proxy, otherwise a client can
  send `X-Forwarded-For: <any ip>` and choose its own bucket); a hop count `N` (trust exactly the last N hops
  from the socket: `1` = one load balancer in front; an extra client-supplied hop is the left-most entry and is
  ignored); or a comma-separated list of proxy IPs/CIDRs (only those peers are trusted).
- Behind a load balancer, set the hop count or CIDR list. With the default, every client behind the LB shares the
  LB's IP and the per-IP budget (300/min) would throttle everyone together.
- Public-access guard (`registerPublicAccessGuard`/`isPublicRequest`): any request carrying `X-Forwarded-For`,
  `X-Forwarded-Host` or `Forwarded`, or whose `Host` is not localhost/`API_PRIVATE_HOSTS`, is treated as coming from the
  public internet and receives a uniform `404 { "error": "Not found" }` for everything except `/health`, `/ready`
  and `/api/telephony/exotel/*`. That check does not depend on `TRUST_PROXY`, so a spoofed forwarding header can
  only make a request LESS privileged. For an internal reverse proxy that adds these headers, list the API's
  internal host in `API_PRIVATE_HOSTS` and strip forwarding headers from untrusted clients at the proxy.
- The guard runs after the global limiter, so 404 probes of the public surface still count against the IP.
- Keys use the resolved `req.ip` only; they are hashed, so IPv6/IPv4-mapped forms are treated as distinct strings
  (normalise at the proxy if that matters).

## Keying strategy: IP, user, organization (added 2026-10-14)

Request path: browser -> (edge/load balancer) -> Next.js server -> API for server-rendered pages and the sign-in
check in middleware; browser -> API directly for client-side calls. Server-rendered calls reach the API from the web
server's address, so the per-IP budget is shared by every user whose page is rendered there.

| Budget | Key | Default | Applies to | Purpose |
|---|---|---|---|---|
| Global per-IP | `req.ip` (socket, or `X-Forwarded-For` only from `TRUST_PROXY` peers) | 300 / 60 s (`RATE_LIMIT_API_MAX`) | every non-exempt request, authenticated or not, evaluated before the login gate | abuse ceiling; the only budget an unauthenticated or forged-cookie request can hit |
| Per authenticated user | verified `req.auth.userId` | 300 / 60 s (`RATE_LIMIT_USER_MAX`) | requests with a verified session, evaluated after the login gate | ordinary dashboard budget that users behind one address do not share |
| Per organization | verified `req.ctx.organizationId` | 1500 / 60 s (`RATE_LIMIT_ORG_MAX`) | same | one tenant cannot monopolise the API |
| Sensitive routes | per route (IP, IP+email or user) | unchanged | login, MFA, password, ... | unchanged, always fail closed |
| Calls per org | organization | unchanged | call initiation | unchanged |

Properties (tests: `rate-limit-identity.test.ts`): `X-Forwarded-For` from an untrusted peer or with no `TRUST_PROXY`
is ignored; prepended chain entries cannot choose a bucket; a forged cookie never reaches the user bucket (it is
still charged to the IP); users of one organization on one address have separate budgets while sharing the org
ceiling; another organization is unaffected; exempt endpoints and preflights are never charged.

Honest limitation: the per-IP bucket still counts authenticated requests, so with ONE shared server address and no
`TRUST_PROXY`/forwarding the IP ceiling (300/min) is still reached by the aggregate of all users before their
individual budgets matter. Raise `RATE_LIMIT_API_MAX` for the web server's address, or forward the client address.
Forwarding the visitor's address from Next.js as `X-Forwarded-For` was evaluated and **not** implemented: the
public-access guard answers 404 to every request carrying that header (see above), so the dashboard would stop
working. The options for the security owner are (a) list the API's internal host in `API_PRIVATE_HOSTS` and make the
guard ignore `X-Forwarded-For` from addresses in `TRUST_PROXY`; or (b) a dedicated internal header honoured only from
a configured web-server address. Either changes the public-exposure trust boundary and needs explicit approval.

Deployment requirements: set `TRUST_PROXY` to the exact proxy hop count or address list in front of the API (never
`true` unless the API is unreachable except through it); set `RATE_LIMIT_API_MAX` for the number of users expected
behind the web server; keep the web server the only caller from its address.

## Residual risks

- Fixed-window boundary burst (2x).
- The counter store is the main database: limiter writes add load during a flood (one upsert per request) and a
  flood of unique keys (e.g. random emails on login) creates rows until the janitor removes them.
- Fail-open mode removes global per-IP throttling during a store outage (logged and counted).
- Shared NATs share one per-IP budget; the sensitive routes are per-user for that reason.
