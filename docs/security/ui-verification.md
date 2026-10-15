# Account-security UI: browser verification

Real-browser (Playwright, Chromium) check of `/account/security`, the sign-in second-factor step, the enrolment
banner and the middleware, against a disposable database. First run 2026-10-14; re-run with the one-command runner the same day.

## How to run

One command, from the repo root (Windows Git-Bash, Linux, CI):

```
pnpm --filter @voice-agent/web e2e
```

Prerequisites: `pnpm install`, `pnpm --filter @voice-agent/web exec playwright install chromium`, and a Postgres
server that `E2E_ADMIN_URL` can create databases and roles on (default
`postgresql://voice_agent:voice_agent@127.0.0.1:5440/postgres`, the local docker container; CI uses
`postgres:postgres@localhost:5432`).

`apps/web/e2e/run.mjs` does everything: drops and creates `voice_agent_ui_test`, migrates it, creates the throwaway
login role `voice_app_uitest` (member of the NOLOGIN runtime role `voice_app`), seeds two orgs, starts the API on :4100
(restricted role, mock providers, own cookie name) and a COPY of apps/web on :3100 (a developer's `next dev` on :3000
and its `.next` are untouched), runs the Playwright specs for phase `off` and then `enforce`
(`MFA_ENFORCEMENT=enforce`; DB recreated and API restarted between phases), then kills both servers (taskkill /T on
Windows, process group on Linux), removes the web copy and drops the database and role.
Options: `E2E_PHASES=off`, `E2E_KEEP_DB=1`, `E2E_LOG_DIR=<dir>` (api-<phase>.log, web.log), `E2E_ADMIN_URL`.
It refuses to start if :3100 or :4100 is busy.

Isolation: database `voice_agent_ui_test` only (never `voice_agent_mvp`). The runner pins `DATABASE_URL`,
`DATABASE_ADMIN_URL` and `DATABASE_MIGRATION_URL` in every child process, because the API scripts also read the
repo-root `.env` (see "Incident" below). Owner credentials are used only by `src/scripts/ui-e2e-setup.ts`, which
refuses names without `ui_test`.

TOTP codes are generated in the test with the `otpauth` package from `apps/api/node_modules`.
The login route allows 10 attempts per IP+email per 15 minutes, so the suite reuses sessions and the runner restarts
the API per phase (limits are in-memory).

CI: job `e2e` in `.github/workflows/security.yml` (written but not executed; GitHub Actions cannot run locally).

## Results

| # | Scenario | Result |
|---|----------|--------|
| 1 | Sign in; open /account/security (cards, "This device") | PASS |
| 3 | Change password; the other session is signed out | PASS |
| 4 | Enrol MFA: QR image loads, manual key shown, recovery codes shown once and gone after reload | PASS |
| 5 | Sign in requires a code; protected page shows the code step while pending; wrong code error; right code | PASS |
| 6 | Recovery-code login works once; reused code rejected; count decrements | PASS |
| 7 | Sessions list shows "This device"; "Sign out all other devices" revokes the rest (other browser is signed out) | PASS |
| 7b | Per-row "Sign out" on another session | PASS (after the CORS fix, re-run 2026-10-14) |
| 8 | `MFA_ENFORCEMENT=enforce`, ADMIN: banner shown, `/api/agents` returns 403, security page reachable, enrol lifts the block | PASS |

## Bugs found

1. **CORS blocks DELETE/PATCH/PUT from the browser (API, since fixed: `methods` list added to the cors registration).** `apps/api/src/auth/auth.plugin.ts`
   registers `@fastify/cors` with `{ origin, credentials }` only, so preflights answer
   `access-control-allow-methods: GET,HEAD,POST`. The web app calls the API cross-origin, so every PATCH/PUT/DELETE
   in `apps/web/src/lib/api.ts` fails in the browser ("Unable to reach the server"), including revoking a single
   session, and likely agent/project updates, module toggles and organisation rename. Fix: add
   `methods: ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]` to the cors registration.
2. **Middleware redirect left the 127.0.0.1 origin (web, fixed).** `NextResponse.redirect(req.nextUrl.clone())`
   goes through `NextURL`, which rewrites loopback IPs to `localhost`. Visiting `http://127.0.0.1:3000/anything`
   unauthenticated, or with a half-finished login (password ok, code pending), landed on
   `http://localhost:3000/login`: a different origin, so the session cookie was missing and the API CORS call failed,
   and the second-factor step never appeared. Fix in `apps/web/src/middleware.ts`: when the Host is `127.0.0.1`,
   serve `/login` with `NextResponse.rewrite` (same origin; the URL bar keeps the requested path, and `next` is
   passed through); other hosts still get a normal redirect.

Not bugs (test notes): the Next dev route announcer is an always-present `role=alert`, so tests select the form
error as `p[role=alert]`; the page header sits inside `<main>`, so session-row buttons are scoped to their `li`.

## Re-run (one-command runner)

```
$ pnpm --filter @voice-agent/web e2e
=== phase off ===      6 passed (scenarios 1, 3, 4, 5, 6, 7 including 7b)
=== phase enforce ===  1 passed (scenario 8)
Phase results: off=PASS enforce=PASS     (exit code 0, about 75 s; ports 3100/4100 free and DB/role dropped afterwards)
```

## Incident while building the runner

The first two attempts of `run.mjs` ran `src/db/migrate.ts` with only `DATABASE_URL` set. `migrate.ts` prefers
`DATABASE_MIGRATION_URL`, which the repo-root `.env` defines, so those two runs applied the repository migrations to
whatever database that variable names (the developer database) instead of `voice_agent_ui_test`; the seed step then
failed because the throwaway database stayed empty. Migrations are idempotent, but check
`drizzle.__drizzle_migrations` of the developer database if that matters. Fixed by pinning the variable. The old
shell scripts (`reset-db.sh`, `run-phase.sh`, `start-api.sh`, `start-web.sh`) had the same latent problem and were
removed in favour of `run.mjs`.
