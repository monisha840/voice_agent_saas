# Payment gateway / public webhook: design checklist (review BEFORE any implementation)

Status: design requirements only. No gateway is integrated and **no public payment webhook route exists**
(`billing-security.test.ts` asserts that no route accepts a payment event). Nothing in this file may be implemented
until a security owner has reviewed and signed off each section. Items marked [exists] are already in the code base
and verified by tests; everything else is a requirement.

## 1. Trust boundary

- [ ] The webhook endpoint is the ONLY unauthenticated billing surface. Add it to the security-owned public-route
  allow-list explicitly (not via a generic wildcard), with its own rate limit, body-size limit and no cookies/CSRF
  assumptions.
- [ ] Authentication of the sender is the provider signature over the RAW body (bytes as received, before any JSON
  parsing or re-serialisation). No IP allow-list as the sole control; no shared secret in the URL.
- [ ] Parse only AFTER verification; unverified input never reaches the service. [exists: `VerifiedPaymentEvent` is only
  constructible by an adapter; the service takes nothing else.]
- [ ] Fail closed: missing/invalid signature, unknown event type, unknown provider => reject with a generic 4xx and a
  security event, no detail about which check failed.

## 2. What must be verified

- [ ] Signature in constant time, with the correct algorithm and encoding per provider; secret loaded from the secret
  store, rotated, never logged. [exists in the mock adapter: HMAC, constant-time compare, production refusal]
- [ ] Timestamp/tolerance window against replay of old captured requests, in addition to event-id idempotency.
- [ ] Provider account / merchant id in the payload matches ours (a valid signature from another merchant of the same
  provider must not be accepted).
- [ ] Currency (INR), amount and plan price consistency: the amount paid must match the catalog price for the plan in
  the signed metadata; mismatches are recorded and NOT applied.
- [ ] Live vs test mode flag is rejected in production and vice versa.

## 3. Tenant derivation and provider mapping

- [ ] The organization is derived from data WE attached at checkout creation and the provider signed (checkout
  metadata / subscription reference), then cross-checked against our own mapping `subscriptions.provider_subscription_id`
  (or a dedicated checkout-reference table). Never from an unsigned field, a URL, a header or the caller.
- [ ] If metadata and mapping disagree, or the reference is unknown: record + alert, apply nothing.
- [ ] One provider customer/subscription maps to exactly one organization; re-linking requires an owner action and an
  audit record.
- [ ] Event processing runs as a system actor inside that tenant's scope (RLS applies). [exists: `handleVerified`
  refuses non-system actors and a context/event organization mismatch]

## 4. Authorization

- [ ] No end user can invoke event handling or supply an event. [exists: system-only; no route]
- [ ] Checkout creation and plan-change requests stay `org:manage` (OWNER) and record intent only; entitlement
  changes only from verified events. [exists]
- [ ] The adapter holds the only provider credentials; the app role never receives them in request paths and they
  never appear in logs, traces, audit payloads or error messages.

## 5. Replay, duplicates, ordering

- [ ] Idempotency on `(provider, eventId)` before any effect, in the same transaction as the effect. [exists]
- [ ] Redelivery after a 5xx must be safe: outcomes `applied/ignored/duplicate/stale/conflict` all return 2xx except
  `conflict` (return 5xx so the provider retries against fresh state). [semantics exist; HTTP mapping to design]
- [ ] Ordering: decide and review the rule in `security-review-ws1.md` section 4; strict ordering needs a
  per-subscription `last_applied_event_at`. Out-of-order success/failure/cancel sequences must be tested against the
  chosen provider's real delivery behaviour (staging).
- [ ] Validation of period/plan/amount at the boundary returns a non-retryable 4xx to the provider (so it does not
  retry forever) and alerts. [exists: `ValidationError` for `periodEnd <= periodStart`]

## 6. Operational

- [ ] Reconciliation job against the provider's settlement/payment list; discrepancies alert, never auto-grant.
- [ ] Refunds/chargebacks as events that reduce or reverse entitlement (policy decision).
- [ ] Dunning/grace policy and notifications (state machine has `past_due`; `BILLING_GRACE_DAYS`).
- [ ] GST invoicing requirements (GSTIN, HSN/SAC, place of supply, sequential numbers) before charging real money.
- [ ] Never store card numbers, CVV, UPI PIN; provider references only.
- [ ] Metrics/alerts: signature failures, unknown-tenant events, stale/ignored rates, conflict loops.
- [ ] Staging test plan against the provider sandbox (signature, replay, out-of-order, tenant mismatch) executed and
  recorded before enabling in production; feature flag defaulting to off.

## 7. Sign-off gate

Do not merge any route, adapter or secret for a real gateway until: sections 1-5 are reviewed by the security owner,
section 6 has an owner and a plan, and a negative-test suite equal to `billing-security.test.ts` exists for the new
endpoint (forged tenant, replay, wrong signature, wrong merchant, stale event, oversized body).
