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

1. Get an Exotel account with AgentStream (Voicebot Applet) enabled and an ExoPhone capable of outbound calling.
2. Set in `.env`:
   ```
   TELEPHONY_PROVIDER=exotel
   EXOTEL_API_KEY=...
   EXOTEL_API_TOKEN=...
   EXOTEL_ACCOUNT_SID=...
   EXOTEL_SUBDOMAIN=api.in.exotel.com   # or api.exotel.com for Singapore region
   EXOTEL_FROM_NUMBER=...               # your ExoPhone
   EXOTEL_WEBHOOK_BASE_URL=https://<publicly-reachable-host>   # e.g. an ngrok tunnel in dev
   EXOTEL_AGENTSTREAM_WEBHOOK_SECRET=...
   ```
3. The API must be reachable from the public internet at `EXOTEL_WEBHOOK_BASE_URL` (use a tunnel like ngrok for local dev) so Exotel can reach the status-callback and media-stream endpoints.
4. Restart the API. Clicking "Call Lead" will now place a real outbound call.

### Activating real Sarvam

1. Get a Sarvam AI API key from https://www.sarvam.ai (or the Sarvam developer console).
2. Set in `.env`:
   ```
   AI_PROVIDER=sarvam
   SARVAM_API_KEY=...
   SARVAM_STT_MODEL=saaras:v3
   SARVAM_LLM_MODEL=sarvam-105b
   SARVAM_TTS_MODEL=bulbul:v3
   ```
3. Restart the API. The live call pipeline will now use real speech-to-text, the real LLM, and real text-to-speech.

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
