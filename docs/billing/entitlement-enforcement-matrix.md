# Entitlement enforcement matrix

Status as of **2026-10-21** (decision D3 applied; first written 2026-10-14, security workstream 1, item 5). Source of
truth for the keys: `entitlementsSchema` and `ENTITLEMENT_ENFORCEMENT` in
`apps/api/src/modules/billing/plan-types.ts`, and the `entitlements` JSON in `plans` (seeded by migration 0019,
narrowed by migration 0025). A guard test (`billing-pure.test.ts`, `billing-ws1.test.ts`) fails if a key is added to
the schema or to a plan without an explicit status here, so an advertised limit cannot silently be left unclassified.

**Every entitlement this product advertises is now enforced.** The four keys that were configuration-only were removed
on 2026-10-21 rather than built or relabelled - see "Removed, never implemented" below. Adding a key back means:
a server-side gate, a test that proves it refuses, a row in the table below, and the key in `entitlementsSchema` +
`ENTITLEMENT_ENFORCEMENT`. The guard tests also assert the removed keys stay out of the schema and out of every
`plans` row, so one cannot reappear by accident.

Legend: ENFORCED = a server-side gate refuses the action and a test proves it. (The historical statuses NOT
IMPLEMENTED = value is configuration only, nothing checks it, and NOT AVAILABLE = the feature does not exist, are no
longer used by any live key; they survive only in the removal record below.)

| Entitlement (plan key) | Status | Enforcement point | Applies to | Bypass paths considered | Tests |
|---|---|---|---|---|---|
| Subscription status (`trialing/active/past_due/suspended/canceled/expired`, derived at read time) | ENFORCED | `callAdmission.admit` -> `evaluateEntitlements`, called first by `callLimits.createCall` (every call type and channel) | managed orgs only; fails closed (`STATE_UNAVAILABLE`) | stored status never swept: derived from clock; unknown status refused | `billing.test.ts` (expired trial, suspended/canceled/enterprise), `billing-security.test.ts` (suspended admits nobody), `billing-audit.test.ts` (period/grace) |
| `includedMinutes` (plan column + `limit_overrides.includedMinutes`) | ENFORCED, with a documented overshoot | evaluation in `call-admission.ts`, then an atomic re-check inside `callsRepository.createWithinLimits` under the per-org advisory lock (metered seconds + in-flight x reserve >= included) | managed orgs, per billing period | parallel admissions (serialised by the lock); in-flight calls reserve `BILLING_ADMISSION_RESERVE_SECONDS`; overshoot bound in README | `billing.test.ts` (MINUTES_EXHAUSTED), `billing-ws1.test.ts` (30 parallel -> exactly 10; boundary -> exactly 1; reserve 120/0) |
| `maxConcurrentCalls` | ENFORCED | plan cap lowers the configured cap passed to `createWithinLimits` (advisory lock, count-then-insert) | managed orgs; lower of plan and operator-configured cap wins | test/outbound/inbound share one path; cap independent per org | `billing.test.ts` (atomic under parallel creation), `billing-security.test.ts` (15 parallel -> N; mixed call types; per-tenant) |
| `maxAgents` | ENFORCED | DB trigger `billing_enforce_agent_cap` (migration 0020), create and unarchive, per-org advisory lock | managed orgs; never reduces existing agents; missing key = no cap | any code path (trigger, not service) | `billing-audit.test.ts` (parallel creation, unarchive, per-org), `billing-migration.test.ts` |
| `maxTeamMembers` | ENFORCED | DB triggers on `memberships` and `invitations` (members + pending invitations), per-org advisory lock | managed orgs; existing seats never removed | direct membership inserts and invitations both covered | `billing-audit.test.ts` (parallel invitations), `billing-migration.test.ts` |

## Removed, never implemented (2026-10-21)

Decision **D3**: these four keys were advertised in the seeded plan JSON while nothing in the product ever checked
them. The owner's decision was to **stop advertising them, not to build them** - an unenforced data-retention
guarantee in a plan is legal exposure, and the other three describe features that do not exist. They are not
"deferred" or "coming soon": there is no commitment here to deliver any of them.

| Removed key | Previous status | Why it was never real |
|---|---|---|
| `retentionDays` (14/30/90/365) | NOT IMPLEMENTED | retention is ONE global operator setting (`SECURITY_EVENT_RETENTION_*`, `docs/security/audit-retention.md`); no per-plan, per-organization purge job exists, and building one needs a legal/policy decision about deleting customer data (overlaps D7) |
| `analytics` (`none/basic/advanced`) | NOT IMPLEMENTED | no tiered analytics exist; every organization sees the same dashboard |
| `apiAccess` | NOT AVAILABLE | no API-key / public API feature exists to gate |
| `webhooks` (outbound) | NOT AVAILABLE | no outbound webhook delivery exists to gate |

What changed:

* Migration **`0025_drop_unenforced_entitlements.sql`** strips the four keys from the `entitlements` JSON of every
  `plans` row (idempotent; data only - no schema, policy, role or grant change). Migration 0019 must not be edited
  (already applied everywhere, documented stored-hash mismatch), so it still seeds the dead keys into a brand-new
  database and 0025 strips them again immediately afterwards.
* `plan-types.ts`: the keys are out of `entitlementsSchema` (and therefore out of `limitOverridesSchema`) and out of
  `ENTITLEMENT_ENFORCEMENT`, so `GET /api/billing/plans` no longer returns them in either `data` or
  `meta.entitlementEnforcement`. `REMOVED_ENTITLEMENTS` records them for the guard tests.
* **Stale stored keys are tolerated, not rejected.** `entitlementsSchema` is a non-strict Zod object, so a dead key
  still present in a `subscriptions.limit_overrides` row (or in a plan row in a database not yet at 0025) is stripped
  on read: it can neither grant nor refuse anything, and the real negotiated limits beside it are unaffected.
  `subscriptions.limit_overrides` is deliberately *not* rewritten by 0025 - that table has FORCE ROW LEVEL SECURITY,
  so an owner `UPDATE` without a tenant context would match no rows anyway.
* Tests: `billing-pure.test.ts` ("nothing unenforced is advertised", "the keys removed as never-implemented are
  gone", stale-key tolerance) and `billing-ws1.test.ts` (no `plans` row carries a removed key; 0025 re-run is a
  no-op).
* Not changed by this work, and still to do by whoever owns them: the optional `retentionDays` / `analytics` /
  `apiAccess` / `webhooks` fields in the web client type (`apps/web/src/lib/billing.ts`, nothing renders them), the
  column comment in `apps/api/src/db/schema.ts`, `docs/release/decisions.md` (D3 is still marked OPEN there),
  `docs/staging-readiness-report.md`, `docs/release/README.md` item 6 and `docs/billing/security-review-ws1.md`
  item 4. **Public pricing pages, sales collateral and any customer contract must not mention retention windows,
  analytics tiers, API access or webhooks.**

## Related limits that are not plan entitlements

| Limit | Status | Where |
|---|---|---|
| Daily call quota, per-org concurrent cap (operator configuration) | ENFORCED | `createWithinLimits`, applies to every organization |
| Monthly call-seconds quota (operator configuration, from `usage_events`) | ENFORCED when > 0 | `callLimits.assertWithinMonthlyQuota`; separate from, and not reconciled with, the plan ledger |
| `BILLING_ENFORCEMENT=off` | rollout switch | refuses nothing at the admission layer; **seat-cap triggers stay on** |

## Gaps and decisions (nothing was silently implemented)

1. ~~`retentionDays`, `analytics`: advertised in seeded JSON but not enforced.~~ **Closed 2026-10-21 (D3): removed,
   not built** - migration 0025 and the schema change above. Nothing is advertised that is not enforced.
2. ~~`apiAccess`, `webhooks`: features do not exist.~~ **Closed 2026-10-21 (D3): removed** with the same change. Keep
   them out of marketing copy; they are not on a roadmap here.
3. Unmanaged (pre-billing) organizations bypass every plan limit by design (`UNMANAGED_LEGACY`). An operator must
   assign a subscription to put an organization under plan limits. A security owner should decide whether a hard
   cut-off date for unmanaged organizations is wanted.
4. Seat caps are evaluated against live counts at insert time. A downgrade below current usage blocks only NEW seats.
   Whether a downgrade should force-archive existing seats is a product decision.
5. The monthly call-seconds quota (calendar month, from `usage_events`) and the plan minutes (billing period, from
   `usage_ledger`) are two independent meters. Keep the operator quota at 0 (off) or above any plan to avoid a
   second, confusing refusal reason.
