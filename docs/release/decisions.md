# Release-candidate decision log

Prepared: 2026-10-14 (release-candidate preparation, deliverable 4). Every record below is **OPEN**. This document
describes the current behaviour and the options; it does **not** choose a business, billing, security or operations
policy. A record moves to DECIDED only when the named owner role writes the decision, date and reference into it.

Facts are taken from code and docs in this repository as of this date. File paths are relative to the repository root;
API source is under `apps/api/src/`.

| ID | Decision | Owner role | Status |
|---|---|---|---|
| D1 | Minute overshoot policy, 7,200 s billable cap, 60 s admission reserve | business + billing | OPEN |
| D2 | Strict payment-event ordering (per-subscription high-water mark) | billing + security | OPEN |
| D3 | Unenforced `retentionDays` and `analytics` entitlements | business | OPEN |
| D4 | Legacy unmanaged organizations | business + security | OPEN |
| D5 | Direct Exotel streams, production number/flow inventory, account-sid and edge IP allow-lists | security + ops | OPEN |
| D6 | Migration 0022 approval and execution | security (approve) + ops (execute) | OPEN |
| D7 | Security-event retention policy (5 sub-decisions) | business/legal + security | OPEN |
| D8 | Payment gateway gate | business + security + billing | OPEN |

---

## D1. Minute overshoot policy, 7,200 s call cap, 60 s admission reserve

**Owner:** business (overage policy) + billing (parameter values). **Status: OPEN.**

### Context
Included-minute admission happens at call start and cannot know how long an admitted call will last, so a managed
organization can use more than its included minutes in a period. There are no paid overages; overshoot is never
charged automatically (`docs/billing/README.md`, "Permitted overshoot").

### Current behaviour
- Defaults in `modules/billing/billing-policy.ts` (`getBillingPolicy`):
  - `BILLING_MAX_CALL_SECONDS` = **7200** (accepted range 60-86,400; invalid values fall back to the default). It caps the
    **billable** seconds of one call: `metering.ts` computes `roundUp(min(duration, maxBillableSecondsPerCall), increment)`.
  - `BILLING_ADMISSION_RESERVE_SECONDS` = the rounding increment, i.e. **60** by default (`BILLING_ROUNDING_INCREMENT_SECONDS`
    default 60; range 0-86,400; `0` disables reservations).
- Admission rule (under the per-organization advisory lock in `callsRepository.createWithinLimits`): refuse with
  `MINUTES_EXHAUSTED` when
  `meteredSeconds + inFlightCalls x BILLING_ADMISSION_RESERVE_SECONDS >= includedSeconds`.
- **Documented overshoot bound** (`docs/billing/README.md`, `docs/billing/security-review-ws1.md` section 1):
  ```
  usage <= includedSeconds - 1 + (maxConcurrentCalls x BILLING_MAX_CALL_SECONDS)
  ```
  plus a bounded under-count for calls that ended between the pre-lock reconcile and the lock (each at most
  `BILLING_MAX_CALL_SECONDS`, counted by the next reconcile).
- Related but separate: the physical call length is bounded by `MAX_CALL_DURATION_MS` (default 1,800,000 ms = 30 min,
  `config/env.ts`; enforced by `CallGuard` in `websocket/exotel-media-stream.handler.ts`; `0` disables it). The 7,200 s
  billing cap therefore only binds if `MAX_CALL_DURATION_MS` is raised above 7,200,000 or disabled, or on a path that
  does not use `CallGuard`. The overshoot formula in the docs uses the billing cap, not the physical cap.
- Example with defaults: Starter (300 included minutes = 18,000 s, 3 concurrent calls) can reach up to
  17,999 + 3 x 7,200 = 39,599 billable seconds in a period in the worst case, before the under-count term.
- Tests: `billing-ws1.test.ts` ("included-minute admission is atomic": 30 parallel -> exactly 10 for 600 s / 60 s;
  reserve 120 -> 5; reserve 0).

### Options
| Option | Trade-off / risk |
|---|---|
| A. Keep defaults (reserve 60 s, cap 7,200 s), document overshoot as included goodwill | Most permissive; worst-case unbilled usage is large relative to small plans (see example); provider cost (telephony + Sarvam) for overshoot is absorbed. |
| B. Raise the reserve (e.g. 600 s, or the plan's typical call length) | Tighter effective bound; calls refused earlier while in-flight calls are still short; customers may see `MINUTES_EXHAUSTED` with minutes visibly left. |
| C. Lower `BILLING_MAX_CALL_SECONDS` (e.g. to match `MAX_CALL_DURATION_MS` = 1,800 s) | Shrinks the formula's bound 4x with no customer-visible refusal change; calls longer than the cap are billed only up to it (only reachable if the physical cap is raised). |
| D. Introduce paid overage | Requires a payment gateway (D8), pricing, invoicing/GST; not implemented. |
| E. Hard stop live calls when the allowance is crossed | Not implemented; ends customer calls mid-conversation; product/UX and legal implications. |

### Blocked until decided
Final plan copy on included minutes; customer terms about overage; any pricing sign-off; enabling real-customer billing.

### Decision record
Decision: ________  Values: reserve ____ s, cap ____ s, `MAX_CALL_DURATION_MS` ____  Owner/date: ________  Reference: ________

---

## D2. Strict payment-event ordering via a per-subscription high-water mark

**Owner:** billing + security. **Status: OPEN.**

### Context
Payment-provider webhooks can arrive out of order. No real gateway or webhook route exists yet; the handler
(`paymentEventsService.handleVerified`) is exercised only by a test-only mock adapter.

### Current behaviour
- `isStalePaymentEvent` in `modules/billing/subscription-state.ts`: an event is stale (recorded as `ignored`, outcome
  `stale`, no state change) if `event.occurredAt < sub.currentPeriodStart`, or if it is a `payment_succeeded` whose own
  `periodStart < sub.currentPeriodStart`.
- Duplicates/replays: idempotent on the global unique key `(provider, eventId)` in `billing_events`.
- Limitation (`docs/billing/security-review-ws1.md` section 4): ordering is relative to the **current period start**,
  not to the last applied event. Two events inside the same period apply in arrival order, e.g. a late
  `payment_failed` can briefly move a subscription to `past_due` after a later success until the next success.
- There is no `last_applied_event_at` column; adding one is a schema change (new migration).

### Options
| Option | Trade-off / risk |
|---|---|
| A. Keep the period-start rule | No schema change; documented intra-period misorder risk (temporary wrong status, possible wrongful refusal of calls during `past_due`/suspension transitions). |
| B. Add `subscriptions.last_applied_event_at` (high-water mark); ignore events older than it | Strict total order by provider timestamp; needs a migration, rollback script, upgrade test; depends on the provider's timestamp semantics (clock skew, equal timestamps need a tie-breaker). |
| C. Do not trust event order; on each event re-fetch authoritative subscription state from the provider API | Most robust; requires a real gateway integration and outbound API credentials; more moving parts. |

### Blocked until decided
Gateway adapter design and its staging test of out-of-order delivery (`docs/billing/gateway-trust-boundary-checklist.md`
section 5); any migration after 0022 that touches `subscriptions`.

### Decision record
Decision: ________  Owner/date: ________  Reference: ________

---

## D3. Unenforced `retentionDays` and `analytics` entitlements

**Owner:** business (with legal input for retention). **Status: OPEN.**

### Context
Plans seeded by migration `0019_billing_foundation.sql` carry `retentionDays` (14/30/90/365) and `analytics`
(`basic`/`advanced`) in their entitlements JSON (`docs/billing/README.md`, plan table).

### Current behaviour
- `docs/billing/entitlement-enforcement-matrix.md`: `retentionDays` and `analytics` are **NOT IMPLEMENTED**; nothing in
  the product checks them. Retention is a single global operator setting (`SECURITY_EVENT_RETENTION_*`); no
  per-organization purge job exists. No tiered analytics exist. (`apiAccess`, `webhooks` are NOT AVAILABLE.)
- The UI shows only ENFORCED entitlements as plan benefits (`ENTITLEMENT_ENFORCEMENT` in
  `modules/billing/plan-types.ts`, also returned in `GET /api/billing/plans` `meta`). A guard test fails if a key is
  added without a status.

### Options
| Option | Trade-off / risk |
|---|---|
| A. Build: per-org data-retention purge job + tiered analytics | Delivers advertised value; retention means deleting customer data (needs legal policy, backup handling, legal hold - overlaps D7); significant scope; analytics tiers need a product definition. |
| B. Remove the keys from seeded plans and the schema until built | Honest catalog; needs a new migration to update `plans` rows and a schema/guard-test change; marketing must not mention them. |
| C. Relabel as "coming soon"/informational (keep data, keep hidden from benefits) | Lowest effort; risk that sales or marketing copy presents them as included; keeps a misleading value in the catalog. |

### Blocked until decided
Public plan/pricing pages and sales collateral; any customer contract mentioning retention or analytics tiers.

### Decision record
Decision: ________  Owner/date: ________  Reference: ________

---

## D4. Legacy unmanaged organizations

**Owner:** business + security. **Status: OPEN.**

### Context
Organizations that existed before migration 0019 have no `subscriptions` row.

### Current behaviour
- `modules/billing/entitlements-engine.ts` (`evaluateEntitlements`): no subscription row -> `managed: false`,
  `allowed: true`, reason `UNMANAGED_LEGACY`, message "This organization is not on a managed plan; platform default
  limits apply." They keep the operator-configured limits (daily quota, per-org concurrent cap, monthly
  call-seconds quota) and bypass every plan limit, including seat-cap triggers (which apply only to organizations with
  a subscription).
- An organization becomes managed only when an owner starts a trial (`POST /api/billing/trial`) or an operator assigns a
  subscription. There is no cut-off date and no automatic migration.

### Options
| Option | Trade-off / risk |
|---|---|
| A. Keep indefinitely (grandfathered) | No disruption; permanent uncapped tier outside billing; revenue and abuse exposure grows with the number of such orgs. |
| B. Cut-off date, then assign a plan (e.g. Starter or a legacy plan with `limit_overrides`) by operator action | Predictable; requires notice to customers, an operator runbook, and a decision on which plan/overrides; seat caps then apply (existing seats are never removed, new seats blocked if over cap). |
| C. Cut-off date, then treat unmanaged as refused (fail closed) | Strongest control; risks blocking live customers who miss the notice. |
| D. Migrate all now via a data migration to a trial | Fast; trials expire (`TRIAL_EXPIRED`) and would block calls unless converted. |

Sub-decisions: cut-off date; target plan and overrides per org; customer communication; who executes and audits the
assignment.

### Blocked until decided
Claiming that "all organizations are under plan limits"; enabling real-customer billing for existing customers.

### Decision record
Decision: ________  Cut-off date: ________  Target plan: ________  Owner/date: ________

---

## D5. Direct Exotel streams, production inventory, account-sid and edge IP allow-lists

**Owner:** security (policy) + ops (dashboard inventory, edge config). **Status: OPEN.**

### Context
A "direct" stream authenticates with the shared secret and carries a `start.call_sid` that matches no call row; with
the flag on, the stream itself creates an inbound call (`docs/security/stream-direct-dependencies.md`). Exotel
documents no signature for streams or callbacks (`docs/security/exotel-auth-capabilities.md` section 5).

### Current behaviour (defaults in `config/env.ts`)
| Setting | Default | Note |
|---|---|---|
| `STREAM_INBOUND_DIRECT_ALLOWED` | `true` | `false` refuses unregistered call_sids after ~3 s (1008, `unregistered_call_sid`, `access.stream_denied`, `stream_auth_denied_total`) |
| `STREAM_ALLOWED_ACCOUNT_SIDS` | empty = not enforced | plus `EXOTEL_ACCOUNT_SID` when set |
| `STREAM_ALLOW_STATIC_SECRET` | `true` | |
| `STREAM_REQUIRE_GRANT` | `false` | |
| `STREAM_INBOUND_MAX_AGE_MS` / `STREAM_FLOW_MAX_AGE_MS` | 600,000 / 1,800,000 | static-secret streams only |
| `STREAM_TOKEN_TTL_MS` / `STREAM_TOKEN_MAX_USES` | 900,000 / 3 | |
| `STREAM_GRANT_TTL_MS` / `STREAM_GRANT_MAX_USES` | 600,000 / 3 | |
| `STREAM_STATIC_REQUIRE_PENDING_STATUS` | `false` | |

Recommended production block (proposal, not applied): `docs/security/stream-direct-dependencies.md` section 3. Setting
`STREAM_INBOUND_DIRECT_ALLOWED=false` breaks only flow 1 (inbound number -> bare Voicebot static URL with no webhook
applet). Which production numbers use flow 1 **cannot be inferred from code**; the Exotel dashboard is the only source.

### Required production inventory (fill from the Exotel dashboard before any flag change)
Flow types are those of `stream-direct-dependencies.md` section 2: 1 = bare Voicebot static URL (depends on direct),
2 = inbound webhook applet then Voicebot static URL, 3 = dynamic endpoint `/stream-url`, 5 = outbound flow mode.

| # | ExoPhone (last 4 digits only) | Exotel account SID / sub-account | Region (India/Singapore) | App Bazaar flow name + id | Direction | Applet chain (in order) | Voicebot URL form (static `?token=` / Basic-in-URL / dynamic) | Flow type (1/2/3/5) | Mapped org / agent | Breaks with `direct=false`? | Remediation needed | Verified by / date (UTC) | Screenshot ref |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | | | | |

Rules: never record the secret or full applet URL with credentials; one row per number per flow; an entry without a
verifier and screenshot reference is not counted.

### Options
| Item | Options | Trade-offs / risks |
|---|---|---|
| Direct streams | A. Keep `true`. B. `false` after inventory shows no flow-1 number. C. `false` plus migrate flow-1 numbers to the webhook applet (flow 2) or dynamic endpoint (flow 3) first | A: anyone with the shared secret can create inbound calls for a mapped number. B/C: a missed flow-1 number silently loses all inbound calls (refused 1008). Rollback is a flag flip, no data change. |
| Account-sid allow-list | A. Leave empty (not enforced). B. Set to production account SID(s) | B rejects streams from other accounts cheaply; a forgotten sub-account/sandbox is refused. |
| Edge IP allow-list on `/api/telephony/exotel/*` | A. None. B. Allow only Exotel ranges from support, re-confirmed quarterly | B is the most valuable single compensating control (`exotel-auth-capabilities.md` section 5); ranges are not public, must come from Exotel in writing, can change (outage risk if stale). |
| Edge query-string logging | Must be off for `/api/telephony/exotel/*` regardless | otherwise secrets/tokens/grants land in edge logs. |

### Blocked until decided
Production enablement of Exotel inbound; staging gate G4 (`exotel-staging-test-plan.md` section 8); flag-flip order
step 1 (section 9); any claim that inbound stream authentication is hardened.

### Decision record
Decision: direct ____ / account SIDs ____ / edge IP list source+date ____  Inventory sign-off: ________  Owner/date: ________

---

## D6. Migration 0022 approval and execution

**Owner:** security owner approves; ops/DB owner executes. **Status: OPEN.**

Full procedure, SQL review and test evidence: **[migration-review.md](migration-review.md)** (written separately; that
document is authoritative where it differs from this summary).

Facts: `apps/api/src/db/migrations/0022_billing_grants_hardening.sql` is additive, privileges only:
`REVOKE UPDATE ON billing_events FROM voice_app`, `REVOKE UPDATE ON usage_ledger FROM voice_app`,
`GRANT UPDATE (state) ON usage_ledger TO voice_app`. Rollback: `apps/api/src/db/rollback/0022_billing_grants_hardening.down.sql`
(re-grants table-level UPDATE; loosens privileges; scratch-tested only). Development database state: per
`candidate_preparation.md` it is at 0021 with 0022 pending; `docs/security/migration-reconciliation.md` also records the
0019 hash mismatch (early draft applied to dev) - do **not** rewrite 0019 to match.

### Approval gates (summary)
| Gate | Requirement |
|---|---|
| Who approves | Security owner signs the SQL and rollback; DB/ops owner names the executor and window; for production also the release owner. |
| Prerequisites | Target confirmed (host/db printed by `migrate-guard`); target's applied set read-only verified (journal rows, 0019 hash status); upgrade and clean-install tests green (`migration-upgrade.test.ts`, `billing-migration.test.ts`, `billing-ws1.test.ts`) on disposable databases; app build that expects 0022 ready. |
| Backup | `pg_dump -Fc` of the target immediately before, with sha256 recorded and a test restore into a scratch database. |
| Apply | Owner role via `npm run db:migrate` with `MIGRATION_TARGET_CONFIRM=<db name>` (or the three statements by hand as owner if only 0022 is wanted); never as `voice_app`. |
| Verify | `has_table_privilege` / `has_column_privilege` for `voice_app`: `billing_events` SELECT, INSERT only; `usage_ledger` UPDATE on `state` only; app-role update of a content column fails; supersede still works; drizzle row count equals journal entries. |
| Rollback | Run the 0022 down script as owner; remove the 0022 row from `drizzle.__drizzle_migrations` only if it will be re-applied; re-verify grants. |

### Blocked until decided
Applying 0022 to dev, staging or production; staging item PG-03.

### Decision record
Approved by: ________  Target(s): ________  Window: ________  Backup sha256: ________  Result: ________

---

## D7. Security-event retention policy (5 sub-decisions)

**Owner:** business/legal (periods, hold, backups) + security (archive access). **Status: OPEN.**

### Current behaviour
Deletion is OFF and cannot be enabled by accident: `SECURITY_EVENT_RETENTION_ENABLED=true` is ignored unless
`SECURITY_EVENT_RETENTION_APPROVAL_REF` is set (`config/env.ts`), and periods must be whole days >= 30 when enabled
(`docs/security/operations-and-validation-plan.md` section 2). Placeholder periods (days): `auth_session` 400,
`mfa_config` 730, `access_denied` 400, `privileged_action` 730, `other` 400. `SECURITY_EVENT_RETENTION_ARCHIVE`
default `false`.

| # | Sub-decision | Options / risk | Status |
|---|---|---|---|
| 7.1 | Retention period per category | keep placeholders / set legal values; too short loses forensic evidence, too long increases personal-data exposure | OPEN |
| 7.2 | Archive owner and archive retention | archive on/off; `security_events_archive` holds IPs and user agents and has **no purge job** | OPEN |
| 7.3 | Category mapping (`membership.*` -> security configuration 730; `auth.account.*` -> auth/session 400; SQL `app_security_event_category`) | confirm / change mapping (schema function change) | OPEN |
| 7.4 | Legal hold | none exists today; build per-tenant/per-incident hold before enabling, or accept risk | OPEN |
| 7.5 | Backup handling | purged rows persist in backups; align backup retention or document | OPEN |

### Blocked until decided
Enabling deletion (`SECURITY_EVENT_RETENTION_ENABLED`); the production exit criterion "retention policy approved (or
deletion explicitly left disabled)" (`operations-and-validation-plan.md` section 3.4). Overlaps D3 option A.

### Decision record
Approval reference (`SECURITY_EVENT_RETENTION_APPROVAL_REF`): ________  Owner/date: ________

---

## D8. Payment gateway gate

**Owner:** business (gateway choice, GST, refund terms) + security (trust boundary sign-off) + billing. **Status: OPEN.**

### Current behaviour
No gateway is integrated, no public payment-webhook route exists (`billing-security.test.ts` asserts none accepts a
payment event), no real charge can occur. `modules/billing/payment-provider.ts` has an interface and a mock adapter that
refuses `NODE_ENV=production`. Only a verified payment event makes a subscription `active`.

### Options
Gateway choice (Razorpay, Cashfree, PayU, other); dunning/grace policy (`BILLING_GRACE_DAYS` default 3); refund and
chargeback policy; GST invoicing; recurring-mandate rules. Each carries the requirements in
`docs/billing/gateway-trust-boundary-checklist.md`.

### Gate (unchanged, from the checklist section 7)
No route, adapter or secret for a real gateway is merged until sections 1-5 of the checklist are reviewed by the
security owner, section 6 has an owner and a plan, and a negative-test suite equivalent to `billing-security.test.ts`
exists for the new endpoint. Depends on D2 (ordering) and D1 (overage).

### Blocked until decided
Real-customer billing; invoices; any public billing endpoint.

### Decision record
Gateway: ________  Checklist sign-off: ________  Owner/date: ________

---

## D9. Owner-role `TRUNCATE` of the append-only ledger (raised by the migration review, D4)

**Owner:** security + DBA. **Status: OPEN.** Not a 0022 blocker.

`usage_ledger_guard_trg` is a row-level `BEFORE UPDATE OR DELETE` trigger, so it does not fire on `TRUNCATE`. The
runtime role cannot truncate (`42501`, no privilege); the **owner/migration role can** (verified in a rolled-back
transaction). Options: (a) accept, since the owner can also drop the trigger, so protection against the owner is
procedural (access control and audit on the owner credential); (b) add a `BEFORE TRUNCATE ... FOR EACH STATEMENT`
trigger in a future migration, which raises the bar against accidental truncation, though an owner can still disable it.
Same question for `billing_events`. Decision: ________  Owner/date: ________

## D10. Test runs reset the cluster-wide `voice_app` password (raised by the working-tree review, P2)

**Owner:** engineering lead. **Status: OPEN.**

`apps/api/src/test/global-setup.ts` runs `ALTER ROLE voice_app LOGIN PASSWORD '<fixed test value>'`. Roles are
cluster-wide, so running the API suite on the same PostgreSQL server as a dev database gives that server's `voice_app`
a known password and LOGIN. Local dev currently logs in as `voice_app_dev` (a member of `voice_app`), so dev keeps
working, but `voice_app` itself becomes loginable with a published password on that server. It never affects
production unless tests are pointed at a production server (forbidden). Options: (a) accept for local and CI only and
document "never run tests against a shared or staging server"; (b) run tests on a separate PostgreSQL server or container;
(c) restructure tests to log in as a dedicated member role (for example `voice_app_test IN ROLE voice_app`) and leave
`voice_app` NOLOGIN, which is a test-harness role change needing review. Decision: ________  Owner/date: ________
