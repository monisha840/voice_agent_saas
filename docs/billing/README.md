# Billing, plans, usage metering and quotas

Status: **foundation, not production-ready.** No payment gateway is integrated and no real charge can occur. All
prices and limits are provisional business assumptions awaiting approval.

## What exists

| Concern | Where |
|---|---|
| Plan catalog (configuration) | table `plans`, seeded by migration `0019_billing_foundation.sql`; read via `GET /api/billing/plans` |
| Tenant subscription state | table `subscriptions` (one row per organization) |
| Metered usage (append-only) | table `usage_ledger` |
| Verified payment events (idempotency) | table `billing_events` |
| Pure rules | `modules/billing/subscription-state.ts`, `metering.ts`, `billing-policy.ts` |
| Entitlement evaluation | `modules/billing/entitlements-engine.ts` |
| Call admission hook | `modules/billing/call-admission.ts`, called from `modules/calls/call-limits.ts` |
| Payment boundary | `modules/billing/payment-provider.ts` (interface + test-only mock) |
| API | `modules/billing/billing.routes.ts` (`/api/billing/*`) |
| UI | `/billing` (plan & usage), `/onboarding` (setup checklist) |

Organizations that existed before this migration have **no subscription row** and are reported as *unmanaged*: they are
allowed and keep today's configuration-based limits. Nothing changes for them until an owner starts a trial
(`POST /api/billing/trial`) or an operator assigns a subscription.

## Plans (provisional defaults, `plans` table)

| Plan | Price (INR / month) | Included minutes | Concurrent calls | Agents | Team | Retention | Analytics | API / webhooks |
|---|---|---|---|---|---|---|---|---|
| Trial (14 days, not self-selectable) | 0 | 30 | 1 | 1 | 3 | 14 d | basic | no |
| Starter | 2,999 | 300 | 3 | 3 | 5 | 30 d | basic | no |
| Growth | 14,999 | 2,000 | 10 | 10 | 15 | 90 d | advanced | yes |
| Business | 49,999 | 8,000 | 30 | 30 | 50 | 365 d | advanced | yes |
| Enterprise | custom (NULL) | negotiated | negotiated | negotiated | negotiated | negotiated | | |

Prices are stored as integer paise; the UI formats INR from the catalog and hard-codes none. Change a plan with an
owner-connection `UPDATE plans ...`; the application role has `SELECT` only. A subscription's `limit_overrides` JSON
(`includedMinutes`, `maxConcurrentCalls`, ...) carries negotiated limits and wins over the plan. An Enterprise plan
without overrides is **refused** (`LIMITS_NOT_CONFIGURED`) rather than treated as unlimited.

### Entitlement enforcement matrix

Full matrix with tests: `docs/billing/entitlement-enforcement-matrix.md`.

| Entitlement | Status | Where enforced |
|---|---|---|
| Subscription status (trial/active/past_due/suspended/canceled/expired) | ENFORCED | `callAdmission.admit` on every call creation |
| Included minutes (per billing period) | ENFORCED | `callAdmission.admit` + atomic re-check under the advisory lock (see "Included-minute admission") |
| Concurrent calls | ENFORCED | plan cap passed to the advisory-locked `createWithinLimits` |
| Active agents (`maxAgents`) | ENFORCED | DB trigger, migration 0020 (create and unarchive; per-org advisory lock) |
| Team members (`maxTeamMembers`) | ENFORCED | DB triggers on `memberships` and `invitations` (members + pending invitations) |
| Retention days | NOT ENFORCED | retention is a global operator setting, not plan-controlled |
| Analytics tier | NOT ENFORCED | no tiered analytics exist |
| API access | NOT AVAILABLE | there is no API-key / public API feature |
| Webhooks | NOT AVAILABLE | there is no outbound webhook delivery |

The seeded JSON still carries retention/analytics/API/webhook values as configuration, but the UI presents only
ENFORCED entitlements as plan benefits (`ENTITLEMENT_ENFORCEMENT` in `plan-types.ts`, also returned in
`GET /api/billing/plans` `meta`). Seat caps are database-enforced regardless of `BILLING_ENFORCEMENT`; they apply only to
organizations with a subscription, never reduce existing seats, and a missing cap key means "no cap". They surface to
clients as HTTP 429 with code `AGENT_LIMIT_REACHED` / `TEAM_MEMBER_LIMIT_REACHED`
(`modules/billing/cap-errors.ts`, hooked in the app error handler).

## Subscription state

Statuses: `trialing`, `active`, `past_due`, `suspended`, `canceled`, `expired`.

```
trialing --(trial end)--> expired                   any open --cancel--> cancel_at_period_end --(period end)--> canceled
trialing/past_due/suspended/expired/canceled --verified payment--> active
active --payment failed--> past_due     active --(period end, no renewal)--> past_due --(grace days)--> suspended
```

* Time-based transitions are **derived at read time** (`effectiveStatus`), so a lapsed organization can never look
  active because a sweep has not run. The stored row is changed only by owner actions or verified payment events.
* Only a **verified payment event** makes a subscription `active`. `POST /api/billing/plan-change` records the owner's
  intent (`scheduled_plan_key`) and changes no entitlement.
* Cancellation is "at period end"; `resume` withdraws it. Both are optimistic-locked and audited.

Roles: reading status/usage needs `usage:read` (OWNER, ADMIN). Any change needs `org:manage` (OWNER only). MANAGER and
AGENT cannot read or change billing. The plan catalog needs `org:read` (every member).

## Usage calculation

Source of truth: the persisted `calls` row (`status`, `started_at`, `ended_at`), never client input.

1. test calls: 0 (`test_call`); not terminal yet: not metered;
2. never answered (`started_at` NULL): 0 (`unanswered`);
3. answered but no end time (interrupted): 0, state `pending` (`interrupted`);
4. failed after connecting: billed unless `BILLING_BILL_CONNECTED_FAILED_CALLS=false`;
5. shorter than `BILLING_MIN_ANSWERED_SECONDS` (default 3): 0 (`too_short`);
6. otherwise `min(duration, BILLING_MAX_CALL_SECONDS)` **rounded up** to `BILLING_ROUNDING_INCREMENT_SECONDS`
   (default 60 = per started minute). 125 s becomes 180 s = 3 minutes.

Duration is whole seconds: `round((ended_at - started_at) / 1000)`. Included minutes are compared with the sum of
billable seconds of non-superseded rows whose `occurred_at` (call end) lies in `[period_start, period_end)`; a call
ending exactly at `period_end` belongs to the next period.

Idempotency: one row per call, key `call:<callId>`, unique per organization. Webhook retries, the media stream and the
provider callback both reporting the same call, and concurrent reconcilers all converge on one row. Out-of-order: a
`pending` row is superseded by a `final` row (`call:<id>:final`) once the end time exists. Corrections are new rows that
supersede the old one; the original is retained. A database trigger rejects every update except
`pending -> final -> superseded`, and every delete, for **all** roles including the table owner.

Integration points (both idempotent on the same key, so running both can never double-count):

1. **At the terminal transition** (`modules/billing/call-ended-hook.ts`, called from `calls.service.ts` right after the
   atomic `transitionToTerminal` succeeds, and from the stale-call reaper). This covers every outcome (completed, failed,
   busy, no-answer, reaped), is independent of summary generation, and never throws into the lifecycle.
   `finalizeCall` is NOT used for metering: it runs only for completed calls and aborts before `recordCallUsage` if
   summary generation fails or no conversation row exists.
2. **Reconcile** before every entitlement evaluation (drains the backlog in batches; a backlog it cannot drain fails
   closed) and `POST /api/billing/usage/reconcile`. This is the safety net for a crash between the transition and (1).

## Quotas and concurrency

`callLimits.createCall` (every call type and channel) calls `callAdmission.admit(organizationId)` first:

* unmanaged organization: admitted, configured limits apply as before;
* managed: refused with `LimitExceededError` (HTTP 429) whose `code` is one of `TRIAL_EXPIRED`,
  `SUBSCRIPTION_SUSPENDED`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRED`, `MINUTES_EXHAUSTED`,
  `LIMITS_NOT_CONFIGURED`, `PLAN_UNAVAILABLE`, `STATE_UNAVAILABLE`; the message states the next step;
* the plan's concurrent-call cap (combined with the configured one, the lower wins) is enforced by the call
  repository under its per-organization advisory lock, so parallel requests cannot both pass;
* if state cannot be read, the call is refused (`STATE_UNAVAILABLE`): **fail closed**.

### Included-minute admission (atomic reserve-then-settle)

Admission runs in two steps. (1) `callAdmission.admit` evaluates the subscription and reports the period and the
included seconds. (2) `callsRepository.createWithinLimits` re-checks the minutes **under the same per-organization
advisory lock** as the concurrent-call count, then inserts. Under that lock a call is refused with `MINUTES_EXHAUSTED`
when

```
meteredSeconds(non-superseded ledger rows with occurred_at in [period_start, period_end))
  + inFlightCalls * BILLING_ADMISSION_RESERVE_SECONDS  >=  includedSeconds
```

`inFlightCalls` counts calls in `initiating/ringing/in_progress`. Each in-flight call *reserves*
`BILLING_ADMISSION_RESERVE_SECONDS` (default = the rounding increment, 60 s: the least an answered call bills); when a
call ends its real usage is metered and the reservation disappears (settle). Serialising on the lock means N parallel
admissions each see every earlier admitted call, so with nothing used and 600 s included exactly 10 calls are admitted
(in-flight 0..9 reserve 0..540 s) however many are attempted. `0` disables reservations (only metered usage counts).

**Permitted overshoot (explicit policy).** Admission cannot know how long an admitted call will last, so the allowance
can be exceeded by the *unreserved* part of calls in flight. Worst case for one period:

```
usage <= includedSeconds - 1 + (maxConcurrentCalls x BILLING_MAX_CALL_SECONDS)     (default cap per call 7200 s)
```

plus a bounded under-count for calls that ended between the pre-lock reconcile and the lock (each at most
`BILLING_MAX_CALL_SECONDS`, and counted by the next reconcile). Overage is never charged automatically: there are no
paid overages. A deployment that wants a tighter bound lowers `BILLING_MAX_CALL_SECONDS` or raises
`BILLING_ADMISSION_RESERVE_SECONDS` (e.g. 600 s reserves 10 minutes per live call) - a product decision (see
`docs/billing/security-review-ws1.md`). Tests: `billing-ws1.test.ts` ("included-minute admission is atomic").

## Payment-provider boundary (future)

`PaymentProvider` exposes `createCheckout` and `verifyWebhook(rawBody, headers)`. `verifyWebhook` must verify the
signature in constant time and return a `VerifiedPaymentEvent`; `paymentEventsService.handleVerified` accepts only that
type, is system-only, idempotent on `(provider, eventId)`, and applies the event and its record in one transaction.
A mock adapter (HMAC, refuses `NODE_ENV=production`) exercises these paths in tests. **No webhook route is
registered**: a public endpoint belongs to the security-owned public-route list.

Requirements for a real Indian gateway (Razorpay, Cashfree, PayU, ...), none of which is implemented:

* verify the provider signature over the raw body before parsing; reject replays outside a time window;
* idempotent handling of redeliveries (done: `billing_events`) and reconciliation jobs against the provider's
  settlement reports;
* refunds and chargebacks as events that reduce or reverse entitlement;
* GST: invoices with GSTIN, HSN/SAC, place of supply, tax split (CGST/SGST vs IGST), sequential invoice numbers,
  e-invoicing thresholds; prices here are shown **excluding tax**;
* failed-payment retries (dunning), grace policy and notifications (the state machine already has `past_due`);
* recurring-mandate rules (UPI AutoPay / eNACH limits and pre-debit notification);
* never store card numbers, CVV or UPI PIN; keep provider references only.

Invoice and payment-record tables were deliberately not created: with no real payments they would be fabricated data.

## Onboarding

Implemented: `/onboarding` setup checklist computed from real data (workspace, plan, first agent, test call, team) for
signed-in members; owners can start a trial for an existing organization. **Not implemented: self-service organization
creation** (see conflict below). Public registration does not exist in this system (invite-only) and was not added.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BILLING_ENFORCEMENT` | `enforce` | `off` reports state but refuses nothing (rollout/rollback switch) |
| `BILLING_ROUNDING_INCREMENT_SECONDS` | 60 | billable rounding step |
| `BILLING_MIN_ANSWERED_SECONDS` | 3 | answered calls shorter than this are not billed |
| `BILLING_MAX_CALL_SECONDS` | 7200 | cap on one call's billable time |
| `BILLING_ADMISSION_RESERVE_SECONDS` | rounding increment (60) | seconds reserved per in-flight call by atomic minute admission; 0 disables reservations |
| `BILLING_BILL_CONNECTED_FAILED_CALLS` | true | bill calls that connected then failed |
| `BILLING_GRACE_DAYS` | 3 | days between period end/failed payment and suspension |

No secrets are required. Invalid values fall back to the default.

## Decisions still needed from the business / legal

Final prices and allowances; rounding and minimum-duration policy; whether failed-after-answer calls bill; trial length
and minutes; overage policy (block vs paid overage); GST registration details and invoice format; refund and
cancellation terms; data-retention commitments per plan; payment gateway choice; whether ADMINs may manage billing.

## Design proposal for the security owner: self-service organization provisioning

**Status: PROPOSAL, AWAITING SECURITY-OWNER APPROVAL (amended 2026-10-14).** Nothing below is implemented. No RLS policy,
role, grant, `auth.plugin.ts` route list or provisioning code has been changed for it.

### Components

1. **Function-owner role.** `voice_provisioner`, `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
   created by the migration owner. Privileges, nothing more: `USAGE` on schema `public`; `INSERT` on `organizations`,
   `memberships`, `subscriptions`, `audit_logs` (and `organization_modules` only if modules are enabled at creation);
   `SELECT (id, organization_id, user_id)` on `memberships`; `SELECT (key, is_active, trial_days)` on `plans`;
   `EXECUTE` on `app_current_org()`, `app_current_user()`. It owns only `app_create_workspace`.
2. **Function.** `app_create_workspace(p_org_id uuid, p_user_id uuid, p_name text)`:
   * `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp`; every table and function referenced
     schema-qualified (`public.organizations`, `public.app_current_user()`), so no caller-controlled schema can
     shadow an object. `pg_temp` is listed last explicitly so it cannot be searched first.
   * `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO voice_app;` nothing else.
   * **Identity binding (new):** the first statement is
     `IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM public.app_current_user() THEN RAISE ... ERRCODE 'VA004'`.
     `app.user_id` is set only by the application's database client from the verified session (`runInTenant`), so the
     function will act only for the user whose session issued the statement; a compromised caller passing another
     user's id is refused.
   * Sets `app.organization_id = p_org_id` (transaction-local) so the ordinary tenant policies apply to the
     tenant-owned inserts.
   * Takes `pg_advisory_xact_lock(hashtextextended('workspace:' || p_user_id, 0))`, then refuses (`VA001`) a user who
     already has any membership. This serialises double-submits and caps self-service at one workspace per user.
   * Inserts, in this order and in the function's single transaction: organization (server-generated id, trimmed name,
     server-derived slug retried on unique violation), membership with the literal role `'OWNER'` (never a
     parameter), trial subscription read from the `plans` catalog (`VA003` if no active trial plan), audit row
     `org.created` with actor = the user. Any error rolls back all of them.
   * Returns only the slug.
3. **RLS.** One new policy, `organizations_insert_provisioner ON organizations FOR INSERT TO voice_provisioner WITH
   CHECK (id = (SELECT app_current_org()))`. The existing `memberships_insert` / `tenant_isolation` policies already
   allow the remaining inserts once `app.organization_id` is the new id. No existing policy changes; the new
   expression satisfies the "no `USING (true)`" guardrail. Guardrail classification and `system-access.md` updated.
4. **Route and auth gate.** `POST /api/workspaces`, body `z.object({ name }).strict()`. The auth plugin gets an
   explicit allow-list entry for organization-less users: exactly `POST /api/workspaces` (and `GET /api/auth/me`,
   already allowed). No prefix match, no other route. The handler requires `req.auth` (verified session, MFA not
   pending) and passes `req.auth.userId`; the organization id is generated server-side.
5. **Abuse controls (invite-only system).** Eligible callers: authenticated users with no membership whose account was
   created by an invitation or operator (no public sign-up exists). `routeRateLimit` per user (3/day) and per IP
   (10/hour), fail closed; a global cap on self-service organizations per day (configurable, alert when reached);
   `security_events` record every attempt (success, refusal reason); name length/charset validation; the created
   workspace starts on the trial plan only (no paid entitlement without a verified payment).

### Adversarial tests required before enabling

* Atomicity: force a failure after the organization insert (e.g. trial plan inactive) -> no organization, membership,
  subscription or audit row remains.
* Identity: call the function with a different `p_user_id` than `app.user_id` -> `VA004`, nothing written; call with no
  `app.user_id` set -> refused.
* Role: body containing `role`, `organizationId`, `plan` -> 400; the membership is always `OWNER`.
* Concurrency: 10 parallel submits by one user -> exactly one workspace.
* Existing member -> `VA001`.
* `search_path`: a schema `evil` with a shadowing `organizations` table on the caller's path has no effect;
  `pg_proc.proconfig` asserts the fixed path; `prosecdef` is true; `proowner` is `voice_provisioner`.
* Grants: `has_function_privilege('public', ...)` false; `voice_app` still cannot `INSERT INTO organizations` directly;
  `voice_provisioner` cannot `SELECT` other tenants' rows or `UPDATE`/`DELETE` anything.
* Auth gate: an organization-less user can reach only `POST /api/workspaces`; every other route stays
  `NO_ORGANIZATION`; an MFA-pending session is refused.
* Rate limits and global cap enforced; `security_events` written for success and each refusal.
* Upgrade test from 0022 with existing data; guardrail and route-table suites green.

## Operational notes found during the audit

* The global per-IP rate limiter (`RATE_LIMIT_API_MAX`, default 300/min) is keyed on `req.ip`. The Next.js server makes
  every server-rendered request to the API from one address, so unless the API is configured to trust and read the
  forwarded client address, all dashboard users would share one 300/min budget (observed: 429s in a 25-request browser
  run). Security owner to confirm `trustProxy` / forwarded-for handling before real traffic.
* Test databases are wiped per run; run billing suites with their own `TEST_DATABASE_NAME`. Browser e2e for billing:
  `pnpm --filter @voice-agent/web e2e:billing` (own database `voice_agent_billing_ui_test`, role, ports 4291/3291,
  production build of a copy of the web app).
* Rollback: `apps/api/src/db/rollback/0019_0020_billing.down.sql` (scratch-database tested; destroys billing data).

## Security workstream 1 additions (2026-10-14)

* Grants hardening (migration `0022_billing_grants_hardening`): `docs/billing/security-review-ws1.md`.
* Payment event validation and ordering: `docs/billing/security-review-ws1.md` section "Payment events".
* Before any real gateway or public webhook: `docs/billing/gateway-trust-boundary-checklist.md`.
