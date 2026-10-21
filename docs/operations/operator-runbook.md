# Operator runbook

Everything an operator needs to run real customers from the command line. There is no super-admin dashboard, and this
is the deliberate alternative to one: a small set of scripts that use the application's own rules, leave an audit
trail, and are cheaper to trust than hand-written SQL.

**Rule: if a job appears below, use the script. Do not write SQL against a customer's data.** The scripts apply the
password policy, the plan catalog, the subscription state machine and the entitlement rules that the product enforces
at runtime; SQL applies none of them, and leaves no record of who did it.

## 1. Prerequisites

| | |
|---|---|
| Where | the repository root, on a machine that can reach the database |
| Role | `DATABASE_ADMIN_URL` = the **owner/administrative** connection. Every command below needs it; `org:create` reads it through the same path. It must NEVER be set on a serving API process (production config validation refuses to start if it is). |
| Who | `OPERATOR=<your name>` is recorded with every change. Left unset, the OS user name is used. |
| Secrets | passwords are passed in the environment, never as arguments (arguments land in shell history and in `ps`). No command ever prints or logs a password. |

```bash
export DATABASE_ADMIN_URL='postgresql://<owner>:<password>@<host>:<port>/<database>'
export OPERATOR="$(whoami)"
```

Run the commands with `pnpm --filter @voice-agent/api <script>` from the repository root (or `pnpm <script>` from
`apps/api`). All of them exit non-zero and print one line on failure.

## 2. The commands

| Job | Command | Writes |
|---|---|---|
| See every customer | `org:list` | no |
| New customer + first OWNER | `org:create` | yes |
| Put a customer on a plan | `billing:assign-subscription` | yes |
| Customer locked out of their password | `user:admin reset-password` | yes |
| Customer lost their second factor | `user:admin reset-mfa` | yes |
| Shut an account out | `user:admin deactivate` | yes |

### 2.1 `org:list` — who is on what (read-only)

```bash
pnpm --filter @voice-agent/api org:list
pnpm --filter @voice-agent/api org:list --json     # same data, for scripting
```

```
SLUG           NAME               MEMBERS  MODULES  PLAN    STATUS                     PERIOD END  CALLS  LAST CALL
-------------  -----------------  -------  -------  ------  -------------------------  ----------  -----  ----------
demo           Demo Organization  1        sales    -       unmanaged                  -           185    2026-10-17
ops-scratch    Ops Scratch Co     1        sales    growth  active                     2026-11-21  0      -
ops-scratch-2  Ops Scratch Two    1        -        trial   expired (stored trialing)  2026-10-19  0      -
```

Reading it:
- **MODULES** — the optional packs that are switched on. Empty means the always-on voice core only.
- **STATUS** — the status **in force now**, computed from the subscription's own dates (trial end, period end, grace
  window) the same way the entitlement engine computes it. `(stored X)` means time alone has moved the status and the
  stored row has not been swept yet — that is normal, not a fault.
- **`unmanaged`** — the organization has no subscription row at all. These are the organizations that predate billing;
  they are allowed to make calls under the platform's default limits. It is a legitimate state, not an error.
- **`(cancelling)`** — the owner has cancelled; the subscription ends at PERIOD END.
- **LAST CALL** — the start of the most recent call (its creation time if it never started). `-` means they have never
  called: for a new customer, that is the number to watch.

This command only ever reads. It deliberately does not go through the entitlement engine, because the engine
reconciles the usage ledger as it reads, which would make a listing a write.

### 2.2 `org:create` — a new customer

Sign-up is invite-only, so this is how a real customer's first organization and first OWNER come to exist.

```bash
ORG_NAME="Acme Realty" \
OWNER_EMAIL=boss@acme.test OWNER_NAME="A Boss" OWNER_PASSWORD='<long random>' \
  pnpm --filter @voice-agent/api org:create
```

| Variable | |
|---|---|
| `ORG_NAME` | required |
| `ORG_SLUG` | optional; derived from the name otherwise (lowercase, hyphens, ≤60 chars) |
| `OWNER_EMAIL`, `OWNER_NAME` | required for a new owner |
| `OWNER_PASSWORD` | required for a new owner, 10–128 characters. Never printed. |
| `MODULES` / `--modules a,b` | optional packs to enable; `none` enables none. Default: `sales`. |

Notes:
- If the email already belongs to a user, they are attached to the new organization as OWNER and **their password is
  left untouched** (`OWNER_PASSWORD` is then not needed).
- One transaction: a failure leaves no half-created organization. The organization starts with a default agent, and a
  sales agent as well when the sales module is enabled.
- `OWNER_PASSWORD` is only length-checked here. Give the owner a long random password and tell them to change it; or
  set a policy-checked one afterwards with `reset-password` (§2.4).
- The new organization is **unmanaged** until you give it a plan — see next.

### 2.3 `billing:assign-subscription` — put a customer on a plan

Customers cannot put themselves on a paid plan (no payment gateway is wired up: self-service can only start a trial or
*record* a plan request). This is how a paying customer is activated, and how a plan is changed later.

```bash
ORG=acme-realty PLAN=starter REASON="PO-7781 signed" \
  pnpm --filter @voice-agent/api billing:assign-subscription
```

| Variable | |
|---|---|
| `ORG` | required: the organization's slug **or** its id |
| `PLAN` | required: a key from the `plans` table (`org:list` shows what customers are on; an unknown key is rejected with the list of active plans) |
| `STATUS` | `active` (default for a plan without trial days) or `trialing` (default when the plan has them). Nothing else: `past_due`, `suspended`, `canceled` and `expired` are outcomes of the state machine, a verified payment or the owner's own cancellation, never of a script. |
| `PERIOD_DAYS` | optional length of the paid period; the default comes from the plan's own billing interval (`month` → one calendar month) |
| `TRIAL_DAYS` | optional trial length; the default comes from the plan's `trial_days` |
| `LIMIT_OVERRIDES` | optional JSON of negotiated limits (Enterprise). See below. |
| `REASON` | free text, recorded in the audit trail (put the PO / ticket number here) |

It handles both cases without being told which: an organization with **no subscription row** (the unmanaged legacy
state) gets its first one; an organization that already has one is moved to the new plan, its period reset, any
pending plan request cleared and any scheduled cancellation withdrawn. The change is applied with optimistic
concurrency: if the subscription changed underneath the script, nothing is written and it says so — re-run it.

On success it re-reads the organization through the entitlement engine and prints what the customer can actually do:

```
Created the subscription of "acme-realty": starter (active).
Period: 2026-10-21T06:43:52.712Z -> 2026-11-21T06:43:52.712Z.
Entitlements now: allowed=true reason=OK includedMinutes=300 maxConcurrentCalls=3.
```

**Enterprise and negotiated limits.** The Enterprise plan is custom-priced on purpose: it carries no limits of its
own, and the entitlement engine refuses an organization whose limits are not configured (`LIMITS_NOT_CONFIGURED`), so
assigning it bare would leave a customer who cannot place a call. This command therefore **refuses** before writing
anything:

```
$ ORG=acme-realty PLAN=enterprise pnpm --filter @voice-agent/api billing:assign-subscription
billing:assign-subscription failed: Refusing to create a subscription that cannot place a call: plan "enterprise"
sets no maxConcurrentCalls: the entitlement engine would answer LIMITS_NOT_CONFIGURED. Pass the negotiated limits in
LIMIT_OVERRIDES (e.g. '{"maxConcurrentCalls":10,"includedMinutes":5000}'), or leave the organization unmanaged until
they are agreed.
```

Pass the agreed numbers instead:

```bash
ORG=acme-realty PLAN=enterprise PERIOD_DAYS=365 REASON="MSA 2026" \
LIMIT_OVERRIDES='{"maxConcurrentCalls":25,"includedMinutes":20000,"maxAgents":40,"maxTeamMembers":60}' \
  pnpm --filter @voice-agent/api billing:assign-subscription
```

Overrides accept any entitlement key (`maxConcurrentCalls`, `maxAgents`, `maxTeamMembers`, `retentionDays`,
`analytics`, `apiAccess`, `webhooks`) plus `includedMinutes`. An unknown key or a wrong type is rejected.

- Omitting `LIMIT_OVERRIDES` on a customer that already has them **keeps** them — a plan change must not silently
  drop negotiated limits. Pass `LIMIT_OVERRIDES='{}'` to clear them back to the plan's own numbers.
- The same refusal applies to any combination that leaves zero included minutes: every call would be refused with
  `MINUTES_EXHAUSTED`.
- If limits are still being negotiated, **leave the organization unmanaged**. No subscription row means default
  limits and working calls; a broken subscription row means no calls at all.

Each run records a row in the customer's own audit log (`subscription.created_by_operator` /
`subscription.plan_assigned_by_operator`, actor source `operator-cli`) and a `system.privileged_action` security
event, both naming the operator, the reason, the old and new plan, the period and the overrides.

### 2.4 `user:admin reset-password` — a locked-out customer

```bash
NEW_PASSWORD='<long random>' REASON="verified by phone" \
  pnpm --filter @voice-agent/api user:admin reset-password boss@acme.test locked out, verified by phone
```

```
Done. {"sessionsRevoked":1,"accountActive":true}
```

- The password comes from `NEW_PASSWORD` in the environment, is never an argument, and is never printed or logged.
- It must pass the **same policy as a self-service change**: minimum length, maximum length, the common-password
  blocklist, no part of the user's own name or email, and (where enabled) the breached-password check. A refusal names
  the rule (`too_short`, `too_common`, `contains_identity`, `breached`, `check_unavailable`) and is itself recorded as
  `auth.password.rejected`.
- Re-setting the password the account already has is refused: it would revoke sessions while rotating nothing.
- It is hashed with the application's own hasher at the configured cost — there is no second credential path.
- **Every session of that account is ended**, in the same transaction as the new password, and `password_changed_at`
  is stamped. See §4 for why.
- MFA is untouched: the user signs in with the new password and their existing second factor.
- `accountActive: false` in the output means the account is also **deactivated** — the new password alone will not let
  them in.
- Hand the password over out of band (a phone call, not the ticket), and tell the user to change it themselves from
  the dashboard afterwards.

### 2.5 `user:admin reset-mfa` — a lost second factor

```bash
REASON="new phone" pnpm --filter @voice-agent/api user:admin reset-mfa boss@acme.test new phone
```

Removes the TOTP factor and the recovery codes and ends every session. The user signs in with their password and, if
their role requires MFA, is held at enrolment until they set up a new device. It never creates a bypass.

### 2.6 `user:admin deactivate` — shut an account out

```bash
REASON="left the company" pnpm --filter @voice-agent/api user:admin deactivate someone@acme.test left the company
```

Marks the account inactive and ends every session, atomically. There is no `reactivate` command: bringing an account
back is a deliberate gap, not an oversight — ask for one if the need is real.

## 3. Everyday procedures

**New paying customer.**
```bash
ORG_NAME="Acme Realty" OWNER_EMAIL=boss@acme.test OWNER_NAME="A Boss" OWNER_PASSWORD='<long random>' \
  pnpm --filter @voice-agent/api org:create
ORG=acme-realty PLAN=starter REASON="PO-7781" pnpm --filter @voice-agent/api billing:assign-subscription
pnpm --filter @voice-agent/api org:list          # confirm: plan, status, members
```

**Upgrade or renew.** Re-run `billing:assign-subscription` with the new plan (and `PERIOD_DAYS` if the term is not the
plan's default). It resets the period, so re-running it on renewal is the renewal.

**"We cannot make calls."** `org:list` first. `unmanaged` → they are on default limits (not a billing fault).
`expired` / `suspended` / `canceled` → the period or the payment lapsed; assign a current plan. `active` but calls
still refused → check the entitlement reason printed by `billing:assign-subscription`, and the included minutes for
the period.

**"We cannot log in."** Password → §2.4. Lost authenticator → §2.5. Neither, and `accountActive` is false → the
account was deactivated on purpose; find out why before anything else.

## 4. Why a password reset ends every session

A reset that leaves live sessions alone is not a reset. Whoever holds a stolen session cookie keeps the account until
that cookie expires — exactly the situation the reset is meant to end. So:

- The application's own change-password route already ends **all** sessions and issues the requesting device a fresh
  one. The operator reset follows the same rule; it has no session of its own to keep, so nothing is spared.
- Both other operator actions (`deactivate`, `reset-mfa`) already end every session. This is the house rule.
- It is done in **one transaction** with the new hash, so there is no instant at which the old password is already
  dead but old cookies still work.

The cost is that a legitimate user with other devices is signed out of them. That is the right trade for a
credential that has just been handed over a phone line.

## 5. What these scripts cannot do

Known gaps. If one blocks a real customer, ask — do not reach for SQL.

- **No reactivation** of a deactivated account, and no way to change a user's role, email or name.
- **No way to remove** an organization, a membership or a subscription.
- **No cancellation or suspension** from the command line: cancellation is the owner's own action in the dashboard;
  `past_due` / `suspended` / `expired` arrive from the state machine or a verified payment event.
- **No plan catalog editing.** Prices, included minutes and plan entitlements live in the `plans` table and are
  changed by a migration, not by an operator.
- **No payments.** Nothing here records a payment or talks to a gateway; `billing:assign-subscription` records that
  *you* decided the customer is paid up, which is why `REASON` matters.
- **No usage correction.** Metering corrections are a billing-side operation (append-only ledger), not a script here.

## 6. Where the trail is

| What | Where | Read it |
|---|---|---|
| Account-level actions (password changed/rejected, MFA reset, deactivation) | `security_events`, actor = the user, `metadata.operator` = you | SQL / monitoring |
| Subscription changes | the customer's `audit_logs` (`subscription.*_by_operator`, actor source `operator-cli`) **and** `security_events` (`system.privileged_action`) | the customer's own audit view, and SQL |

Neither trail ever contains a password, a token or a session cookie: metadata is redacted before it is written.
