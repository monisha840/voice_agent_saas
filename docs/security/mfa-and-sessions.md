# MFA, sessions, login protection: behaviour and rollout

## Sessions
* Cookie holds a random 256-bit token; only its SHA-256 is stored. httpOnly, SameSite=Lax, `Secure` in production.
  Idle (sliding) and absolute lifetimes; a half-finished login (MFA pending) lives 10 minutes and is never extended.
* Revocation is **by deletion of the session row inside the same transaction as the change**, and every request
  re-reads the session, the user's `is_active`, and the memberships. There is no authorization cache.

| Event | Sessions ended |
|---|---|
| Password change | **all** of the user's sessions; this device receives a fresh session (rotation) |
| Role change in organization X | the user's sessions working in X (they must sign in again; new role applies) |
| Removal from organization X | the user's sessions working in X; sessions in other organizations stay |
| Account deactivation (operator) | all |
| MFA enrolled / disabled | all **other** sessions |
| MFA reset by operator | all |
| Logout / revoke one / revoke others | as named |

`GET /api/auth/sessions` lists only the caller's sessions (no token, no hash, masked IP, device label).
Another user's session id and an already-revoked id are both `404`.

## Re-authentication
Enrolling in MFA, regenerating recovery codes and (explicitly) disabling MFA require a password proof newer than
`REAUTH_WINDOW_MS` (`POST /api/auth/reauthenticate`; the API answers `403 REAUTH_REQUIRED` otherwise).
Changing the password always requires the current password.

## MFA (TOTP, RFC 6238, SHA-1/6/30 s via the `otpauth` library)
* Seed: 160 random bits, sealed with AES-256-GCM (`MFA_ENCRYPTION_KEY`, bound to the user id), never returned
  after enrolment; enrolment needs a confirming code before MFA turns on; an enrolled account cannot be re-enrolled
  over.
* A TOTP step is accepted once (atomic compare-and-set on `users.mfa_last_step`); window is ±1 step.
* 10 recovery codes (50 random bits each), single use, SHA-256 stored, regeneration replaces the whole set.
* Second-factor attempts use the same bounded throttle as logins (5 failures → short lock, exponential, max 15 min).
* Disabling needs the password **and** a valid code; it ends other sessions and is recorded.

## Enforcement and safe rollout for OWNER / ADMIN
`MFA_ENFORCEMENT`:
1. `warn` (default): nobody is blocked; the dashboard shows owners/admins a banner and `/api/auth/me` reports
   `security.mfaEnrollmentRequired=false`, `mfaEnforcement="warn"`.
2. Announce a date; admins enrol (Security page). Check `GET /api/security/events?type=auth.mfa.enrolled`.
3. `enforce`: an OWNER/ADMIN without MFA can sign in but can reach **only** `/api/auth/*` (enrolment, sessions,
   password). Nobody is locked out and there is no bypass flag.

### Lost device / lost recovery codes
No self-service bypass exists by design. An operator with the administrative database role runs
`OPERATOR=<name> pnpm --filter @voice-agent/api user:admin reset-mfa <email> "<reason>"`: it removes the factor and
recovery codes, ends all sessions, and writes `auth.mfa.reset_by_operator` naming the operator. The user signs in
with their password and (under `enforce`) is held at enrolment until they set up a new device. Verify the
requester's identity out of band first.

### Bootstrapping the first administrators
Enable `warn`, have each admin enrol, then switch to `enforce`. If an administrator cannot enrol, an operator
can still run `org:create`/`user:admin` with the admin connection: there is no dependency on an admin session.

## Login protection
* Generic `401 Invalid email or password` for unknown/disabled/wrong; password hashing cost is spent either way.
* Shared (PostgreSQL) counters keyed by SHA-256: **(account, IP) pair** 5 failures → 30 s lock doubling to 15 min;
  **IP** 30 failures; **account across IPs** 20 failures → at most a 30 s delay (an attacker can slow, never
  lock out, the owner). Attempts during a lock do not extend it; a success clears that pair.
* `429` carries `Retry-After` and `code: THROTTLED`.

## Passwords
scrypt (N=32768 default, r=8, p=1, random 16-byte salt, constant-time verify; cost stored per hash). Policy: length
10–128, common-password blocklist, no name/email fragments, optional breached-password screening
(`PWNED_PASSWORDS=fail-open|fail-closed`, only a 5-char SHA-1 prefix leaves the server).

## Audit
`security_events` (append-only for the runtime role): logins, failures, throttles, MFA lifecycle, session
revocation, membership changes, deactivation, privileged system actions. Identifiers and outcomes only; metadata is
redacted; a persistence failure is logged with the full (redacted) event rather than dropped.
Read by OWNER/ADMIN via `GET /api/security/events`. Retention: indefinite by default (FK `RESTRICT` to
organizations); define a retention job before launch (see "Residual risks").
