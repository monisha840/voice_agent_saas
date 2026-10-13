# Real Estate Voice AI — MVP

A demo-ready MVP: dashboard → select a lead → place a real AI voice call → qualify the lead → book a site visit → see the transcript, AI summary, and updated status back in the dashboard.

See [`PROJECT_ARCHITECTURE.md`](./PROJECT_ARCHITECTURE.md) for the long-term multi-tenant SaaS direction and [`MVP_IMPLEMENTATION_PLAN.md`](./MVP_IMPLEMENTATION_PLAN.md) for the MVP scope this repository implements.

## Stack

- **Frontend**: Next.js + React + TypeScript + Tailwind (`apps/web`)
- **Backend**: Fastify + TypeScript (`apps/api`)
- **Database**: PostgreSQL + Drizzle ORM
- **Telephony**: Exotel AgentStream (real adapter) with a mock provider for development
- **AI**: Sarvam Saaras (STT) / Sarvam-105B (LLM) / Sarvam Bulbul (TTS) — real adapters with mock providers for development

## Prerequisites

- Node.js 20+
- pnpm
- Docker Desktop (for local PostgreSQL)

Nothing else is required — no credentials are needed to run the app, seed demo data, or run the test suite. Exotel/Sarvam credentials are only needed to place a **real** phone call or use the **real** AI providers (see below).

## Quickstart (any machine)

```bash
git clone <repo-url>
cd voice_agent

cp .env.example .env
cp apps/web/.env.example apps/web/.env.local

pnpm install
pnpm db:up        # starts Postgres via docker-compose (named volume, not bind-mounted — nothing DB-related is ever written into the repo)
pnpm db:migrate    # applies the Drizzle migrations
pnpm db:seed       # loads Green Valley Residency + 5 demo leads

pnpm dev:api       # Fastify API on http://127.0.0.1:4000
pnpm dev:web       # Next.js dashboard on http://localhost:3000 (separate terminal)
```

Open `http://localhost:3000`.

> **Windows note:** use `127.0.0.1`, not `localhost`, in `NEXT_PUBLIC_API_URL` — Node can resolve `localhost` to the IPv6 `::1` address, which the API does not listen on.

## Provider configuration (mock vs. real)

Two independent switches in `.env` select mock or real providers. The app **starts and runs fully** with both left at their default (`mock`) — no credentials required.

```bash
TELEPHONY_PROVIDER=mock   # or "exotel"
AI_PROVIDER=mock          # or "sarvam"
```

Provider selection is explicit and fixed at process start — the app never silently falls back from a real provider to a mock mid-call. If you set a provider to its real value without the matching credentials, the relevant operation fails with a clear `ProviderConfigError` (e.g. "Exotel credentials not configured"), not a fake success.

### Activating real Exotel

1. Get an Exotel account with **Voice Streaming / AgentStream enabled by Exotel** (it is not part of the self-serve plans; email hello@exotel.com) and an ExoPhone capable of outbound calling.
2. Set in `.env`:
   ```
   TELEPHONY_PROVIDER=exotel
   EXOTEL_API_KEY=...
   EXOTEL_API_TOKEN=...
   EXOTEL_ACCOUNT_SID=...
   EXOTEL_SUBDOMAIN=api.exotel.com      # use the host shown in Dashboard > API Settings (api.in.exotel.com for India)
   EXOTEL_FROM_NUMBER=...               # your ExoPhone
   EXOTEL_WEBHOOK_BASE_URL=https://<publicly-reachable-host>   # e.g. an ngrok tunnel in dev
   EXOTEL_AGENTSTREAM_WEBHOOK_SECRET=...
   ```
3. The API must be reachable from the public internet at `EXOTEL_WEBHOOK_BASE_URL` (use a tunnel like ngrok for local dev) so Exotel can reach the status-callback and media-stream endpoints. Through a tunnel/proxy (or any non-local Host) the API serves **only** `/health` and `/api/telephony/exotel/*`; the dashboard/lead/call/project APIs return 404. Set `API_PRIVATE_HOSTS` if you reach the API by another hostname.
4. Restart the API. Clicking "Call Lead" will now place a real outbound call.

#### Using an App Bazaar flow (Greeting -> Voicebot applet)

Exotel can also carry the audio through a call flow, which is how inbound calls to an ExoPhone reach an agent:

1. In App Bazaar create a flow: **Greeting** applet, then the **Voicebot** applet. Paste the WebSocket URL printed by `pnpm exotel:flow-url` (run in `apps/api`; add `--reveal` to print the real token on your own screen only). It needs a stable `https://` base, so use a fixed domain, not a changing tunnel URL.
2. Assign the flow to your ExoPhone (not the sandbox/trial number).
3. Link that ExoPhone's number to an agent (agent phone numbers). Calls to it are then routed to the agent by the dialed number; no webhook is required.
4. For outbound calls through the same flow, set `EXOTEL_FLOW_APP_ID` to the flow's App ID.

The audio stream itself marks a call answered when it starts and finished (summary, usage) when it ends, so calls work even if Exotel sends no status callbacks. Callbacks that do arrive are harmless duplicates.

### Activating real Sarvam

1. Get a Sarvam AI API key from https://www.sarvam.ai (or the Sarvam developer console).
2. Set in `.env`:
   ```
   AI_PROVIDER=sarvam
   SARVAM_API_KEY=...
   SARVAM_STT_MODEL=saaras:v3
   SARVAM_LLM_MODEL=sarvam-105b-conversations   # the real-time voice model (plain sarvam-105b is a reasoning model, unsuited to live calls)
   SARVAM_TTS_MODEL=bulbul:v3
   ```
3. Restart the API. The live call pipeline will now use real speech-to-text, the real LLM, and real text-to-speech.

### Receiving inbound calls

1. In the dashboard open **Agents → (an agent) → Phone numbers** and add the number the agent should answer (international format; a number belongs to one agent). Works for any agent, with or without the Sales module.
2. In your telephony provider, point the number's inbound flow at `GET|POST <public API base>/api/telephony/exotel/inbound?token=<EXOTEL_AGENTSTREAM_WEBHOOK_SECRET>` (parameters `CallSid`, `CallTo`, `CallFrom`) and at the existing media-stream URL. An inbound call that reaches the media stream without the webhook is routed by its dialed number the same way.
3. Unknown or unassigned numbers are refused (404) and create nothing. The dialed number alone decides the agent and the organization.

### Running in production (Docker)

```bash
docker build -f infra/docker/api.Dockerfile -t voice-agent-api .
docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t voice-agent-web .
docker run --rm --env-file .env voice-agent-api node dist/db/migrate.js     # apply migrations
docker run -d --env-file .env -p 4000:4000 voice-agent-api
```

- With `NODE_ENV=production` the API validates its configuration at startup and refuses to start, listing every problem.
- `GET /health` is liveness; `GET /ready` is readiness (database reachable and not shutting down). Use `/ready` for load-balancer and orchestrator traffic decisions.
- On `SIGTERM` the server stops taking new calls, turns `/ready` red, and lets live calls finish for up to `SHUTDOWN_DRAIN_TIMEOUT_MS` before closing them. Give the container a stop grace period above that value.
- Every response carries `X-Request-Id`; it is also on log lines and in 5xx error bodies.
- Per-organization limits (concurrent calls, daily call quota, monthly call seconds, maximum call length, silence timeout) are configurable; see `.env.example`.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and builds for the API and web, and builds both images.

## Running the test suite

```bash
pnpm --filter @voice-agent/api test
```

Tests exercise the real Postgres database (the same local container used for the app — nothing is mocked at the DB layer) and the **mock** AI/telephony providers (no external credentials are used or required by the test suite). Real-provider adapters are tested only for their configuration-error behavior (i.e. that they fail clearly, never fake a success, when credentials are absent).

> Note: a few tests write to the seeded demo leads (e.g. booking a site visit, marking not-interested) to exercise the full service/tool layer against real data. Re-run `pnpm db:seed` if you want to reset to pristine demo data after running tests — the seed script is idempotent for rows that don't yet exist, but it does not revert rows tests have mutated. For a full reset, drop and recreate the local database volume (`pnpm db:down && docker volume rm voice_agent_pgdata && pnpm db:up && pnpm db:migrate && pnpm db:seed`).

## Demo script (for the MD walkthrough)

1. Open the dashboard — see Green Valley Residency and the 5 seeded leads.
2. Click **Rajesh Kumar** — see his requirement (2 BHK), budget (₹60L–₹80L), and status (NEW).
3. Click **Call Lead**.
   - With `TELEPHONY_PROVIDER=mock`: no real phone rings; the call record and conversation progress exactly as they would in a real call, driven by the mock AI pipeline, so the whole post-call flow (transcript, summary, status update) can be demonstrated without external dependencies.
   - With real Exotel + Sarvam configured: Rajesh's phone actually rings, and the AI (persona "Priya") has a real conversation — introduces itself, asks qualification questions, answers project questions from the database, checks and books a site visit.
4. The lead detail page shows: call status, duration, AI summary, qualification details, transcript, and site visit booking.

## Project structure

See the Final Verification section delivered alongside this implementation for the full annotated folder structure, database schema, API endpoint list, and AI tool list.


## Temporary experiment: Exotel Voice Agent "API Integration" (separate Exotel account)

Exotel's built-in Voice Agent can call an HTTPS API during a conversation. This repo exposes one read-only endpoint for that.
It tests **Exotel's agent using our data**; it does NOT exercise our Sarvam STT/LLM/TTS engine or the AgentStream media
path (that needs bidirectional streaming enabled on the primary account).

- Endpoint: `GET /api/telephony/exotel/demo/property-details[?topic=pricing|configurations|amenities|possession|location|faq|rera|loan|booking|maintenance]`
- Returns the approved knowledge of one project (`EXOTEL_DEMO_PROJECT_ID`); no leads, calls, users or contact data; read-only.
- Off unless `EXOTEL_DEMO_API_KEY` (24+ chars) and `EXOTEL_DEMO_PROJECT_ID` are both set. The key is its own credential, not
  `EXOTEL_AGENTSTREAM_WEBHOOK_SECRET`, so this account never holds the primary account's secret.
- Auth: header `x-api-key: <key>`, or `Authorization: Bearer <key>`, or `?token=<key>` (masked in logs). 60 requests/min per IP.
- Expose for testing: `ngrok http 4000`. Through a tunnel the API serves only `/health`, `/ready` and `/api/telephony/exotel/*`.
- To revert: delete the two `EXOTEL_DEMO_*` variables (the endpoint then returns 404) and delete `modules/projects/demo-property.routes.*`
  plus its registration in `app.ts` if you want the code gone. Nothing else depends on it.


## Temporary channel: browser web call (no telephony provider)

While Exotel AgentStream is not enabled on the primary account, you can talk to an agent from the dashboard with your microphone:
**Test -> Target: "Web call (your microphone)"**. The page speaks the same stream protocol Exotel does (connected / start / media /
mark / stop, 16-bit 8 kHz PCM), so the server runs exactly the pipeline a phone call runs. Nothing about the Exotel integration changed.

- **Off by default.** Enable with `WEB_CALL_ENABLED=true` (API) and `NEXT_PUBLIC_WEB_CALL_ENABLED=true` (web); otherwise the routes do not exist and the option is hidden.
- API: `POST /api/calls/web` (login, `calls:create`, per-organization limits) then WebSocket `/api/web-call/stream?callId=...`.
- Private: needs your session cookie, only the user who created the call can open it, single use, allowed origins only, and it
  answers 404 through a tunnel/non-local host (it is for the machine you are on).
- Use headphones (the microphone can pick up the speaker). Browsers allow the microphone on `http://localhost` and on https.
- It runs on the mock providers until `AI_PROVIDER=sarvam` with a real `SARVAM_API_KEY`.
- To remove it: delete `modules/calls/web-call.routes.ts`, its registration in `app.ts`, and `apps/web/src/app/test/WebCallRun.tsx`.
