# Entitlement enforcement matrix

Status as of 2026-10-14 (security workstream 1, item 5). Source of truth for the keys: `entitlementsSchema` and
`ENTITLEMENT_ENFORCEMENT` in `apps/api/src/modules/billing/plan-types.ts`, and the `entitlements` JSON seeded into
`plans` by migration 0019. A guard test (`billing-pure.test.ts`, `billing-ws1.test.ts`) fails if a key is added to the
schema or to a plan without an explicit status here, so an advertised limit cannot silently be left unclassified.

Legend: ENFORCED = a server-side gate refuses the action and a test proves it. NOT IMPLEMENTED = the value is
configuration only; nothing in the product checks it. NOT AVAILABLE = the feature itself does not exist, so there is
nothing to gate. Do not present a NOT IMPLEMENTED / NOT AVAILABLE entry as a plan benefit (the UI already hides them).

| Entitlement (plan key) | Status | Enforcement point | Applies to | Bypass paths considered | Tests |
|---|---|---|---|---|---|
| Subscription status (`trialing/active/past_due/suspended/canceled/expired`, derived at read time) | ENFORCED | `callAdmission.admit` -> `evaluateEntitlements`, called first by `callLimits.createCall` (every call type and channel) | managed orgs only; fails closed (`STATE_UNAVAILABLE`) | stored status never swept: derived from clock; unknown status refused | `billing.test.ts` (expired trial, suspended/canceled/enterprise), `billing-security.test.ts` (suspended admits nobody), `billing-audit.test.ts` (period/grace) |
| `includedMinutes` (plan column + `limit_overrides.includedMinutes`) | ENFORCED, with a documented overshoot | evaluation in `call-admission.ts`, then an atomic re-check inside `callsRepository.createWithinLimits` under the per-org advisory lock (metered seconds + in-flight x reserve >= included) | managed orgs, per billing period | parallel admissions (serialised by the lock); in-flight calls reserve `BILLING_ADMISSION_RESERVE_SECONDS`; overshoot bound in README | `billing.test.ts` (MINUTES_EXHAUSTED), `billing-ws1.test.ts` (30 parallel -> exactly 10; boundary -> exactly 1; reserve 120/0) |
| `maxConcurrentCalls` | ENFORCED | plan cap lowers the configured cap passed to `createWithinLimits` (advisory lock, count-then-insert) | managed orgs; lower of plan and operator-configured cap wins | test/outbound/inbound share one path; cap independent per org | `billing.test.ts` (atomic under parallel creation), `billing-security.test.ts` (15 parallel -> N; mixed call types; per-tenant) |
| `maxAgents` | ENFORCED | DB trigger `billing_enforce_agent_cap` (migration 0020), create and unarchive, per-org advisory lock | managed orgs; never reduces existing agents; missing key = no cap | any code path (trigger, not service) | `billing-audit.test.ts` (parallel creation, unarchive, per-org), `billing-migration.test.ts` |
| `maxTeamMembers` | ENFORCED | DB triggers on `memberships` and `invitations` (members + pending invitations), per-org advisory lock | managed orgs; existing seats never removed | direct membership inserts and invitations both covered | `billing-audit.test.ts` (parallel invitations), `billing-migration.test.ts` |
| `retentionDays` | NOT IMPLEMENTED | none: retention is a single global operator setting (`SECURITY_EVENT_RETENTION_*`, `docs/security/audit-retention.md`); no plan-level data retention job exists | - | - | none (matrix guard only) |
| `analytics` (`none/basic/advanced`) | NOT IMPLEMENTED | none: no tiered analytics exist | - | - | none (matrix guard only) |
| `apiAccess` | NOT AVAILABLE | no API-key / public API feature exists to gate | - | - | none |
| `webhooks` (outbound) | NOT AVAILABLE | no outbound webhook delivery exists to gate | - | - | none |

## Related limits that are not plan entitlements

| Limit | Status | Where |
|---|---|---|
| Daily call quota, per-org concurrent cap (operator configuration) | ENFORCED | `createWithinLimits`, applies to every organization |
| Monthly call-seconds quota (operator configuration, from `usage_events`) | ENFORCED when > 0 | `callLimits.assertWithinMonthlyQuota`; separate from, and not reconciled with, the plan ledger |
| `BILLING_ENFORCEMENT=off` | rollout switch | refuses nothing at the admission layer; **seat-cap triggers stay on** |

## Gaps and decisions (nothing was silently implemented)

1. `retentionDays`, `analytics`: advertised in seeded JSON but not enforced. Options: remove from the seeded plans and
   the schema until built, or implement. No code gate is cheap or obviously correct (retention would need a per-org
   purge job and a legal/policy decision on deleting customer data), so none was added.
2. `apiAccess`, `webhooks`: features do not exist; keep them out of marketing copy until they do.
3. Unmanaged (pre-billing) organizations bypass every plan limit by design (`UNMANAGED_LEGACY`). An operator must
   assign a subscription to put an organization under plan limits. A security owner should decide whether a hard
   cut-off date for unmanaged organizations is wanted.
4. Seat caps are evaluated against live counts at insert time. A downgrade below current usage blocks only NEW seats.
   Whether a downgrade should force-archive existing seats is a product decision.
5. The monthly call-seconds quota (calendar month, from `usage_events`) and the plan minutes (billing period, from
   `usage_ledger`) are two independent meters. Keep the operator quota at 0 (off) or above any plan to avoid a
   second, confusing refusal reason.
