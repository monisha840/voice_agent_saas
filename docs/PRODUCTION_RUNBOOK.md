# Production runbook (first deployment)

A checklist for putting the API and dashboard on a real host. It states what the code already enforces and what has to be
decided or done by a person. Nothing here has been run against a real production host yet.

## 1. What the code already enforces
With `NODE_ENV=production` the API validates its configuration at start and **refuses to start** listing every problem:

| Setting | Rule |
|---|---|
| `DATABASE_URL` | must be set |
| `WEB_ORIGINS` | must be the dashboard's public origin(s); no localhost |
| `COOKIE_SECURE` | must be `true` (serve over HTTPS) |
| `DEMO_LOGIN_ENABLED` | must be `false` |
| `AUTH_SCRYPT_N` | at least 16384 |

It warns (does not stop) when: `TELEPHONY_PROVIDER` or `AI_PROVIDER` is `mock`, `TRUST_PROXY` is unset behind a load balancer,
`API_PRIVATE_HOSTS` is empty, the Exotel demo endpoint is enabled, or concurrent calls per organization are unlimited.

Also built in: `/health` (liveness), `/ready` (database reachable and not shutting down), a request id on every response,
graceful drain on `SIGTERM` (`SHUTDOWN_DRAIN_TIMEOUT_MS`), per-organization call limits, and circuit breakers on the AI providers.

## 2. Decisions needed before deploying
- [ ] **Host and region.** Where it runs (a cloud region close to callers and to Sarvam/Exotel keeps voice latency low) and budget.
- [ ] **Database.** Managed Postgres with automated backups and point-in-time recovery, not a container on the same machine.
- [ ] **Domain and TLS.** One domain for the dashboard, one for the API (the media-stream WebSocket needs `wss://`).
- [ ] **Business time zone.** Set `BUSINESS_TIME_ZONE` (default `Asia/Kolkata`) so visit slots are right on a UTC server.
- [ ] **Secrets store.** Provider keys (`SARVAM_API_KEY`, Exotel credentials, `EXOTEL_AGENTSTREAM_WEBHOOK_SECRET`) in the host's
  secret manager, never in the repository or the image. Rotate any key that has been pasted into chat or a ticket.
- [ ] **Models.** `SARVAM_LLM_MODEL=sarvam-105b-conversations` (the default); `AI_PROVIDER=sarvam`; realtime flags decided
  (`REALTIME_STT_STREAMING`, `REALTIME_LLM_STREAMING`, `REALTIME_TTS_STREAMING`, `REALTIME_BARGE_IN`).

## 3. Build and release
```bash
docker build -f infra/docker/api.Dockerfile -t voice-agent-api .
docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t voice-agent-web .
docker run --rm --env-file prod.env voice-agent-api node dist/db/migrate.js   # migrations, once per release
docker run -d  --env-file prod.env -p 4000:4000 voice-agent-api
```
CI (`.github/workflows/ci.yml`) already runs typecheck, lint, tests and builds both images.

## 4. Backups and restore (do the restore once before go-live)
1. Daily automated database backup plus point-in-time recovery; keep at least 14 days.
2. **Restore test:** restore the latest backup into a scratch database, run `pnpm db:migrate`, and open the dashboard against it.
3. Record the time the restore took; that is the real recovery time.
4. Pre-migration: take a backup before running migrations on production.

## 5. Monitoring and alerts
The API writes structured logs. Alert on:

| Signal | Source | Why |
|---|---|---|
| `/ready` not 200 | load balancer / uptime check | the database or the process is down |
| `media-stream: reply quality` with `flags` | logs (warning level) | too-long replies, two questions, a booking confirmed with no time, a claimed booking with no tool call |
| Provider failures (`ProviderRequestError`, circuit open) | logs | Sarvam or telephony trouble |
| Calls ended by the guard (`silence_timeout`, `max_duration`) | logs | cost or experience problems |
| Spend per call | Sarvam Usage page, until per-call cost tracking is built | voice is about 87% of the model cost |

## 6. Telephony cut-over (when the provider is ready)
1. `TELEPHONY_PROVIDER=exotel` with the credentials in the secret store; `EXOTEL_WEBHOOK_BASE_URL` set to the public API.
2. Run `pnpm --filter @voice-agent/api exotel:preflight` against the public URL.
3. Place one call from a registered number; confirm the transcript, summary and usage appear in the dashboard.
4. Watch the first ten calls with the reply-quality log open.

## 7. Known gaps before real clients
- Visit slots are a placeholder, not a real calendar (see the calendar decision).
- No do-not-disturb check, consent record or retention job (see `COMPLIANCE_CHECKLIST.md`).
- No payment or billing; usage is metered, customers are not charged.
- No per-call provider cost; use the Sarvam Usage page until it is built.
- Real phone audio (codec, echo, noise, interruption) has not been tested.
