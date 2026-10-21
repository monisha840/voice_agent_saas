# Telephony and Number Management

Status: implemented and tested locally (2026-10-15). Not committed, not deployed; migration 0024 is NOT applied to
any shared database.

## What a customer can do (`/numbers`, `/numbers/:id`)

* See every number of the organization: the agent that answers it, whether it is answering, paused or blocked
  (agent archived), calls and failures in the last 30 days, refused attempts and the last answered call.
* Add a number (E.164; Indian numbers are normalized) and choose the answering agent. Only ACTIVE agents of the
  organization can be chosen.
* Change the answering agent, edit the label, pause/resume routing, remove the number. Changing where calls go on an
  active number (another agent, pausing, removing) asks for confirmation in the browser AND is refused by the API
  without `confirm: true`; a reassignment carries the agent the editor saw (`expectedAgentId`), so a concurrent change
  is refused instead of overwritten.
* See the provider status (simulated / not fully configured, with the missing setting names / connected).
* Run "Check connection" on a number: routing switched on, answering agent active, the real inbound lookup resolves
  the number to this organization (the same system resolver the provider webhook uses, without creating a call),
  provider configured, and, where supported, the number exists on the provider account.
* See recent calls and recent failed calls on the number, linking to the call detail.

Permissions: read = `agents:read` (MANAGER+); add/change/remove/check = `agents:manage` (ADMIN+). AGENT role: none.

## How it works (reuse)

| Need | Reused | Added |
|---|---|---|
| Number -> agent -> organization | `agent_phone_numbers`, `app_resolve_phone_number_org` resolver, `calls.service startInboundCall` | routing switch, refused-attempt record, provider check result (columns) |
| Inbound entry points | `/api/telephony/exotel/inbound`, `/stream-url`, media-stream direct start: all go through `startInboundCall` | pause / archived agent / limit refusals recorded on the number (once per CallSid) |
| Calls per number | `calls` | `calls.line_number` (the dialed number, set for inbound calls) |
| Provider | `ITelephonyProvider` (Exotel, mock) | optional `describeSetup()` and `checkNumber()`; all Exotel HTTP stays in `adapters/telephony/` |

There is no second routing engine: the number page edits the same table the inbound webhook reads. The existing
per-agent numbers card (`/api/agents/:id/phone-numbers`) keeps working on the same rows.

### APIs

| Method | Path | Notes |
|---|---|---|
| GET | `/api/numbers` | `{ provider, numbers[] }` |
| POST | `/api/numbers` | `{ phoneNumber, agentId, label? }` (strict) |
| GET | `/api/numbers/:id` | number + provider setup + 20 recent calls + 10 recent failures |
| PATCH | `/api/numbers/:id` | `{ label?, agentId?, routingEnabled?, expectedAgentId?, confirm? }` |
| DELETE | `/api/numbers/:id?confirm=true` | 409 without confirm while routing is on |
| POST | `/api/numbers/:id/check` | connection check; at most one per number per 15 s (409) |

### Database (migration 0024, additive)

`agent_phone_numbers`: `routing_enabled` (default true, so every existing number keeps answering), `last_inbound_at`,
`refused_count`, `last_refused_at`, `last_refused_reason`, `last_refused_call_id`, `provider_status`,
`provider_detail`, `provider_checked_at`, `updated_at`. `calls`: `line_number` + index
`(organization_id, line_number, created_at)`. No new table, no policy, role or grant change (the resolver still sees
only `organization_id, phone_number`). Rollback: `db/rollback/0024_number_management.down.sql` (read its warning: paused
numbers become active again). Tested by `db/migration-0024.test.ts` (0021 -> 0024 with data, rollback, re-apply).

## Security and reliability

* Every operation is tenant-scoped (`tenantScoped` + forced RLS); another organization's number id is 404 for every
  operation, and the organization never comes from the request.
* Adding a number held by another organization returns one fixed message ("cannot be added ... contact support") that
  says nothing about the holder; the existing per-agent endpoint still says "already assigned to an agent".
* Provider credentials never leave the server; the setup status lists setting NAMES only. The Exotel number list
  contains every number of the platform's Exotel account (other customers' too): it is read server-side, only the
  matching entry's voice capability and "has an incoming flow" flag are kept, nothing else is returned or logged.
* Webhook authentication is unchanged (shared secret, existing design). Duplicate webhooks: calls are idempotent on
  CallSid (existing); a refused attempt is counted once per CallSid. Provider failures in the check (timeout 10 s, 401/403,
  429, 5xx, malformed response) are reported as readable, stored results and never thrown; inbound handling is unaffected
  by recording failures (best effort, logged).

## Provider-side requirements (not something this code can do)

* **The number must exist on the platform's Exotel account** and have an incoming-call flow whose Voicebot/Passthru
  applet points at this platform (`/api/telephony/exotel/inbound` and/or the stream URL, see
  `docs/security/exotel-auth-capabilities.md`). Buying numbers and building flows is done in Exotel by the platform
  operator; Voice Streaming must be enabled on the account by Exotel support.
* The check can confirm the number is on the account and has SOME flow set (`voice_url`). It cannot confirm the flow
  contains our applet: Exotel documents no API for reading a flow's applets.
* The check uses Exotel's documented ExoPhones API (`GET /v2_beta/Accounts/{sid}/IncomingPhoneNumbers`, beta). Only the
  first page is read (page/page_size are documented, the way to request another page is not); a miss on a full page is
  reported as inconclusive. Re-check against the live account before relying on it.
* Not implemented, by design: buying/releasing numbers or assigning flows through Exotel's API (it changes the platform
  account and other customers' setup), outbound caller-ID per number (outbound uses the deployment's
  `EXOTEL_FROM_NUMBER`), project-level routing (a number routes to an agent; the agent's project bindings decide what it
  knows).

## Owner decision needed

Any organization ADMIN can claim any number not yet held by another organization (first come, first served; this was
already true for the per-agent endpoint). On a shared Exotel account, the safe model is operator allocation: numbers
enter an organization's inventory only by an operator action, and customers then route them. That changes a trust
boundary and is not implemented without approval. Until then, an operator should add numbers for customers, and the
connection check's "not on the platform's Exotel account" result flags numbers the platform does not own.

## Tests

| File | What it proves |
|---|---|
| `modules/numbers/numbers.test.ts` (13) | add/normalize/list; invalid number, archived agent, foreign agent, unknown fields refused; foreign-held number refused without detail; reassign/pause/remove need confirm; stale `expectedAgentId` refused; paused number refuses the REAL inbound webhook, records the attempt once per CallSid, resume answers again with `line_number` set; failures per number; archived agent = agent_inactive; cross-org 404 on every operation; MANAGER read-only, AGENT denied, no login 401; check with the simulated provider; check rate limit; Exotel lookup URL/auth, only own entry reported, no credential in the response, 401/timeout/malformed/not-found reported |
| `db/migration-0024.test.ts` (2) | 0021 -> 0024 with data, RLS/policies/resolver grant unchanged, resolver works, re-run no-op, rollback and re-apply |

Not covered: a browser e2e for `/numbers` (typechecked and linted only), and a real Exotel account (no credentials here).
