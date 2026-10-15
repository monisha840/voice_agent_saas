# Billing security review - workstream 1 (2026-10-14)

Scope: included-minute admission, grants on `billing_events` / `usage_ledger`, payment-event validation and ordering,
usage reliability. Facts below are verified by the tests named in each section unless marked otherwise.

## 1. Included-minute admission

Implemented as an atomic reserve-then-settle check under the per-organization advisory lock. Design, formula and the
explicit permitted overshoot are in `docs/billing/README.md` ("Included-minute admission"). Summary:

* refused when `metered + inFlight x BILLING_ADMISSION_RESERVE_SECONDS >= included` (default reserve 60 s);
* worst-case overshoot per period: `maxConcurrentCalls x BILLING_MAX_CALL_SECONDS` beyond the allowance (default
  cap 7200 s per call), because call length is unknown at admission; never charged automatically;
* residual: a call that ended between the pre-lock reconcile and the lock is not yet in the ledger (it is counted by
  the next reconcile); bounded by the same cap.

Tests: `billing-ws1.test.ts` (30 parallel admissions -> exactly 10 for 600 s / 60 s; 12 parallel at 540/600 s ->
exactly 1; reserve 120 -> 5; reserve 0; ended calls settle).

Decision for the owner (not changed): the default reserve of 60 s keeps admission permissive. A reserve of the
plan's typical call length gives a tighter bound at the cost of refusing calls earlier.

## 2. Grants on `billing_events` and `usage_ledger`

Method: grants were read from `pg_catalog` (`has_table_privilege`, `has_column_privilege`) on a scratch database built
from migrations (the test database), never from dev.

| Table | Before (head 0021) for `voice_app` | Legitimate writers found | After migration 0022 |
|---|---|---|---|
| `billing_events` | SELECT, INSERT, UPDATE | only INSERT (`billingEventsRepository.recordAndApply` / `insertIfNew`); **no code updates a row** | SELECT, INSERT |
| `usage_ledger` | SELECT, INSERT, UPDATE | INSERT; UPDATE only of `state` (`usageLedgerRepository.supersede`, `pending/final -> superseded`) | SELECT, INSERT, UPDATE (`state`) only |

DELETE was already revoked (0019). The trigger `usage_ledger_guard` independently enforces "only `state` may change,
only forward, no delete" for every role including the owner; column-level UPDATE adds a second layer for the runtime
role (a bug or SQL injection in the app role can no longer rewrite `billable_seconds`, `organization_id`, keys, ...).
`billing_events` has no equivalent trigger: its immutability now rests on the missing privilege (owner connections can
still edit it; that is the operator path).

Migration: `apps/api/src/db/migrations/0022_billing_grants_hardening.sql` (journal idx 22, additive, privileges only).

### Statement set for the owner to apply (NOT applied to dev `voice_agent_mvp`)

> **Update (2026-10-14, RC review):** dev has since been reconciled: it holds 21 applied rows through 0021, its catalog
> equals a clean 0000-0021 install, and only 0022 is pending. The approval/apply/verify/rollback procedure is in
> `docs/release/migration-review.md`; the rollback below was corrected (see the Rollback line).

Applying migrations normally runs it (`npm run db:migrate`). When this was written dev was behind head (0020, 0021 and 0022
pending); it still has the **0019 hash discrepancy** (see `docs/security/migration-reconciliation.md`): drizzle does not
re-check hashes, so migrating is safe, but **do not rewrite or "fix" 0019 to match the dev hash**. To apply only
this change by hand as the owner role:

```sql
REVOKE UPDATE ON "billing_events" FROM "voice_app";
REVOKE UPDATE ON "usage_ledger" FROM "voice_app";
GRANT UPDATE ("state") ON "usage_ledger" TO "voice_app";
```

(`voice_app_dev` inherits from `voice_app`.) If dev still has the early 0019 draft, it also has DELETE granted and no
triggers/RLS on these tables; `0019` at head, not 0022, is what fixes that (reconciliation doc section 4).
Rollback (`apps/api/src/db/rollback/0022_billing_grants_hardening.down.sql`): `REVOKE UPDATE ("state") ON "usage_ledger" FROM "voice_app";`
then `GRANT UPDATE ON "billing_events", "usage_ledger" TO "voice_app";`. The column-level REVOKE is needed to restore the
exact pre-0022 ACL (otherwise a redundant column grant remains); `billing-migration.test.ts` asserts this.

Tests: `billing-ws1.test.ts` (column-by-column privilege check; app-role UPDATE of content columns rejected;
supersede still works), `billing-migration.test.ts`, `billing-security.test.ts`.

## 3. Payment event with `periodEnd <= periodStart`

Validated before anything is read or written, at two boundaries:

* `paymentEventsService.handleVerified` throws `ValidationError` (HTTP 400-shaped through the error handler) for
  `periodEnd <= periodStart`, missing plan/period on `payment_succeeded`, or invalid dates. Nothing is recorded in
  `billing_events` and the subscription is untouched (previously, an org without a subscription recorded the event as
  ignored first, and the state machine silently turned it into "ignored").
* `createMockPaymentProvider().verifyWebhook` throws `ValidationError` after the signature check (a real adapter must
  do the same); the DB CHECK `subscriptions_period_order` is only a backstop and can no longer be reached.

Tests: `billing-ws1.test.ts` (equal and inverted periods; org without subscription; signed-payload boundary).

## 4. Payment-event ordering, duplicates, replay, cross-tenant

Rules (implemented in `isStalePaymentEvent`, `subscription-state.ts`, used by the service):

1. **Duplicate / replay**: idempotent on the global key `(provider, eventId)` (`billing_events` unique index);
   a second delivery returns `duplicate` even if the body differs or the event id was first seen for another
   tenant. Concurrent deliveries apply once (optimistic lock on `updated_at`; losers get `duplicate`/`conflict`).
2. **Stale**: an event whose `occurredAt` is before `currentPeriodStart` of the subscription (the period now in
   force), or a `payment_succeeded` whose own `periodStart` is before it, is recorded as `ignored` and returns
   `stale`; it changes nothing, and its redelivery is `duplicate`.
3. **Cross-tenant**: the organization comes only from the signed event; the system context must name the same
   organization or the call is refused (`ForbiddenError`) and nothing is written. An event for an organization
   without a subscription is recorded as ignored and changes nothing.
4. Events that do not fit the current status (`InvalidTransitionError`) are recorded as ignored.

Limits of this minimal rule (documented, not hidden): there is no `last_event_at` column, so ordering is relative to
the current period start, not to the previous event. Two events *inside* the same period apply in arrival order (e.g.
a late `payment_failed` for a retry that occurred after the renewal began but before a later success could briefly
move the status to `past_due` until the next success). A strict total order needs a per-subscription high-water mark
(`last_applied_event_at`), i.e. a schema change - listed as a decision for the security/billing owner. The unique
index being global also means two different tenants can never legitimately share one provider event id.

Tests: `billing-ws1.test.ts`, `billing-pure.test.ts`, `billing.test.ts`, `billing-security.test.ts`.

## 6. Usage reliability (calls that finish, fail, disconnect, are reaped)

| Scenario | Behaviour | Test |
|---|---|---|
| Call completes (stream end / provider callback) | metered at the terminal transition, no summary needed, key `call:<id>` | `billing-audit.test.ts` |
| Repeated/concurrent terminal signals, webhook duplicates | one row | `billing-audit.test.ts`, `billing-security.test.ts`, `billing.test.ts` |
| Failed before answer | 0, `unanswered` row (no silent gap) | `billing-audit.test.ts` |
| Connected then failed | billed once (policy `BILLING_BILL_CONNECTED_FAILED_CALLS`) | `billing-ws1.test.ts` |
| Abrupt disconnect (no stream end), reaped | reaper closes and meters; later stream end, reaper reruns and reconcile do not add a row | `billing-audit.test.ts`, `billing-ws1.test.ts` |
| Answered, end time missing | `pending` row with 0 s, finalized once (pending superseded) when the end arrives | `billing.test.ts`, `billing-ws1.test.ts` |
| Crash between the transition and the hook | reconcile (before every entitlement evaluation and via `POST /api/billing/usage/reconcile`) meters unmetered terminal calls, bounded batches, fails closed if backlog not drained | `billing-audit.test.ts` (450-call backlog) |

Idempotency key and unique index guarantee exactly-once; reconciliation is the safety net, not a second path.
Residual: a call still `in_progress` in the DB (process crashed, reaper not yet run) is invisible to the ledger until
the reaper closes it; the in-flight reservation in section 1 accounts for it during that window.

## Decisions needing a security/billing owner

1. Whether to add a per-subscription high-water mark for strict event ordering (schema change).
2. Reserve seconds per in-flight call (default 60) and per-call cap (default 7200): overshoot policy is a business
   decision.
3. Applying 0022 to the dev database (and reconciling dev's early 0019 draft) is the owner's action.
4. Whether `retentionDays` / `analytics` should be removed from seeded plans or built (see the matrix).
