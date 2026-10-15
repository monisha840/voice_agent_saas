# Decision memo: forwarding the visitor IP from the web server to the API (2026-10-14)

**Decision: NOT implemented.** The API cannot currently tell a request from our Next.js server apart from an arbitrary
public request, so any "trusted internal client-IP" header would be forgeable. The existing conservative behaviour
stays: per-IP limit on the socket address (or `X-Forwarded-For` from `TRUST_PROXY` peers only), plus per-user and
per-organization budgets for verified sessions (`docs/security/rate-limiting.md`).

## Why the boundary cannot be enforced today

| Candidate signal | Why it is not sufficient here |
|---|---|
| Peer IP allow-list (only the web server's address may send the header) | The API is deliberately reachable from the internet for Exotel (tunnel / load balancer, see `telephony-auth.ts`). A tunnel agent or LB on the same host connects from the same loopback/private address as the web server, so public requests and web-server requests share the peer address. Local development is exactly this case (ngrok and `next start` both arrive from 127.0.0.1). |
| Static shared-secret header | Replayable by anyone who sees it once (a log line, a misrouted request, a compromised browser extension on an internal tool). Does not bind to the request. |
| `Host` header (`API_PRIVATE_HOSTS`) | Client-controlled. |
| HMAC-signed header (key, timestamp, client IP, method, path, nonce) | Prevents simple replay but still needs a key-distribution and rotation story and a nonce store; and with a single listener it only moves the question to "who holds the key". Viable later, not a substitute for network separation. |

## Infrastructure requirement before this can be implemented

One of the following must exist and be verifiable:

1. **Separate internal listener (recommended).** The API binds a second port reachable only on the private network /
   from the web server (security group / Kubernetes NetworkPolicy). Public ingress (Exotel, tunnel, LB) is routed only
   to the public port, which never honours the header. The header is accepted only on the internal port.
2. **mTLS between web server and API**, with the header honoured only on mutually authenticated connections.
3. A load balancer that **strips** the internal header from all public traffic and is the only path to the API, with
   the web server reaching the API on a distinct internal hostname; plus the HMAC header above as defence in depth.

When one exists, the implementation must: strip client-supplied copies at the web boundary; set the value only from
the edge proxy's `X-Forwarded-For` hop (`TRUSTED_PROXY_HOPS`); accept it only on the internal path; keep the per-IP
check for the resolved address, the per-user/org budgets and the global ceiling; and add spoofing (public request with
the header), missing-header, direct-request and proxy-misconfiguration tests.

## Operational consequence until then

All server-rendered dashboard traffic shares the web server's per-IP ceiling (`RATE_LIMIT_API_MAX`, 300/min default).
Set it for the expected concurrent users behind the web server (for example 50 users x ~10 SSR calls/min = 500) and
monitor `429` rates. Unauthenticated abuse protection is unaffected because login and other sensitive routes have their
own per-IP+email / per-route limits.

**Approval needed from:** security owner (network topology + trust boundary).
