# Real Estate Voice AI SaaS — Project Architecture

Status: **Foundation decisions only. No application code, database, or integrations implemented yet.**

Repository state at time of writing: empty (no files, not a git repo).

---

## A. Recommended Architecture

### A.1 Monorepo vs. single Next.js app

**Decision: Monorepo, modular monolith backend (not microservices, not Next.js API routes as the backend).**

Reasoning:
- The backend has real long-running concerns (WebSocket streams to telephony, BullMQ workers, webhook ingestion) that don't fit cleanly inside Next.js's serverless/route-handler model. It needs to run as a standalone Node.js process (or a few processes: API, worker, WS gateway) that can stay alive, hold socket connections, and scale independently of the frontend.
- A monorepo lets the frontend (dashboard) and backend (API/worker/telephony) share TypeScript types (DTOs, enums like lead status, tool schemas) without publishing packages, while still being deployed and scaled independently.
- "Modular monolith" means: one backend deployable (one Node process family), but internally organized into strict domain modules with explicit boundaries (see B), so it can be split into services later if a domain (e.g., calls/telephony) genuinely needs to scale independently.

Rejected alternatives:
- *Single Next.js app doing everything*: Next.js route handlers are fine for the dashboard's own BFF calls, but are a poor fit for persistent WebSocket telephony sessions, long BullMQ workers, and webhook-heavy ingestion. Mixing these into Next.js muddies deployment and scaling.
- *Microservices from day one*: explicitly ruled out by the brief (rule 14) and premature — the domain boundaries aren't proven yet.

### A.2 High-level runtime shape (V1)

Four deployables, one repo:

1. **`web`** — Next.js dashboard (tenant admin UI, lead views, call transcripts, config). Talks to `api` over REST, never touches the DB directly.
2. **`api`** — Node.js/TypeScript REST + WebSocket server. Owns all business logic, tenant isolation, auth, AI tool execution, telephony/AI adapters.
3. **`worker`** — BullMQ worker process(es) consuming queues (call dialing, retries, WhatsApp sends, follow-up scheduling, usage aggregation). Shares domain/service code with `api` via internal packages — does not duplicate business logic.
4. **`telephony-gateway`** (logically part of `api`, possibly a separate process in practice) — holds the live WebSocket/media-stream session with Exotel AgentStream and brokers audio frames to/from the AI pipeline (STT → LLM → TTS). Kept behind the telephony adapter interface so it can run in-process initially and be extracted later if latency/scale demands it.

All four share internal packages: `@app/domain` (entities, types, zod schemas), `@app/db` (Prisma/Drizzle client + repositories), `@app/config` (env loading/validation).

---

## B. Folder Structure

```
voice_agent/
├── PROJECT_ARCHITECTURE.md
├── package.json                 # workspace root (pnpm workspaces or turborepo)
├── pnpm-workspace.yaml
├── turbo.json                    # if using Turborepo for task orchestration
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── docker-compose.yml            # local Postgres + Redis + (later) MinIO
│
├── apps/
│   ├── web/                      # Next.js tenant dashboard
│   │   ├── app/                  # Next.js app router
│   │   ├── components/
│   │   ├── lib/                  # API client, auth helpers
│   │   └── package.json
│   │
│   ├── api/                      # REST + WebSocket backend
│   │   ├── src/
│   │   │   ├── modules/          # one folder per domain (see below)
│   │   │   ├── middleware/        # tenant resolution, auth, error handling
│   │   │   ├── websocket/        # telephony media-stream gateway
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   └── package.json
│   │
│   └── worker/                   # BullMQ consumers
│       ├── src/
│       │   ├── queues/           # queue + job definitions
│       │   ├── processors/       # one per job type
│       │   └── index.ts
│       └── package.json
│
├── packages/
│   ├── domain/                   # entities, enums (LeadStatus, CallStatus...), zod schemas, DTOs
│   ├── db/                       # Prisma/Drizzle schema, migrations, repositories (tenant-scoped)
│   ├── config/                   # env schema + loader (zod-validated), shared across apps
│   ├── telephony-adapter/        # ITelephonyProvider interface + ExotelProvider implementation
│   ├── ai-adapter/                # ISpeechToText, ILanguageModel, ITextToSpeech interfaces + Sarvam implementations
│   ├── messaging-adapter/        # IMessagingProvider interface + WhatsAppCloudProvider implementation
│   ├── ai-tools/                  # backend-defined tool implementations the LLM may call (never raw SQL)
│   ├── queue/                     # BullMQ queue names, job payload types, shared queue client
│   └── logger/                    # structured logging (pino) + Sentry wiring
│
└── infra/
    ├── docker/                    # Dockerfiles per app
    └── scripts/                   # local setup scripts (db seed, etc.)
```

### Domain modules inside `apps/api/src/modules/` (mirrors the core domains):

```
modules/
├── auth/                # login, session, JWT/Supabase auth integration
├── tenants/             # tenant CRUD, tenant settings
├── users/                # staff users within a tenant
├── roles/                # roles/permissions (RBAC)
├── projects/             # real-estate project catalog
├── project-config/       # pricing, configurations, approved Q&A data per project
├── leads/                # lead entity, lifecycle/state machine
├── calls/                # call session records, media-stream orchestration entry point
├── conversations/        # transcripts, turn-by-turn conversation log, summaries
├── ai-agents/             # agent configuration per tenant (prompt config, voice, tool permissions)
├── site-visits/           # booking/reschedule/cancel logic, slot management
├── sales-reps/            # rep roster, assignment rules
├── whatsapp/              # outbound template sends, inbound webhook handling
├── integrations/          # lead-source connections (Meta Lead Ads), credential storage
├── usage-billing/         # per-tenant usage metering, cost tracking
└── audit-logs/             # immutable action log
```

Each module exposes: `*.routes.ts`, `*.service.ts` (business logic), `*.repository.ts` (DB access, always tenant-scoped), `*.types.ts`. Services are the **only** way AI tools or routes touch data — nothing calls the DB directly except repositories.

---

## C. Database Domain Model (entities & relationships)

All tenant-owned tables carry a **mandatory `tenant_id`** (FK to `tenants.id`), indexed, and every repository method takes `tenantId` as a required first argument — no query path may omit it.

### Core entities

- **tenants** `(id, name, slug, status, plan, created_at)`
- **users** `(id, tenant_id, email, name, role_id, status, created_at)` — staff/admin users of a tenant
- **roles** `(id, tenant_id, name, permissions jsonb)`
- **sales_reps** `(id, tenant_id, user_id?, name, phone, active, assignment_rules jsonb)`

- **projects** `(id, tenant_id, name, location, status)` — a real-estate project/development
- **project_configurations** `(id, project_id, config_type, data jsonb)` — unit types, pricing, amenities, approved Q&A facts (this is the data surface the AI tool layer is allowed to read)

- **integrations** `(id, tenant_id, provider ['meta_lead_ads','google_calendar',...], credentials_ref, status, config jsonb)` — `credentials_ref` points to encrypted secret storage, never the raw secret in this table

- **leads** `(id, tenant_id, project_id, source_integration_id, name, phone, email, status, assigned_rep_id, created_at, updated_at)`
  - `status` enum = the full lifecycle (NEW → QUEUED → CALLING → NO_ANSWER/BUSY → RETRY → ANSWERED → QUALIFICATION → INTERESTED/NOT_INTERESTED/DNC → VISIT_OFFERED → VISIT_BOOKED → CONFIRMED → VISITED/NO_SHOW → FOLLOW_UP)
- **lead_status_history** `(id, lead_id, from_status, to_status, reason, changed_by, created_at)` — append-only audit trail of the state machine

- **calls** `(id, tenant_id, lead_id, agent_id, provider, provider_call_id, direction, status, started_at, ended_at, recording_url, cost_amount, cost_currency)`
- **conversations** `(id, call_id, transcript jsonb, summary text, sentiment text, created_at)` — one per call; transcript stored as structured turns, not raw audio
- **ai_agents** `(id, tenant_id, name, prompt_config jsonb, voice_config jsonb, allowed_tools jsonb, active)` — per-tenant agent configuration, not a code deploy

- **site_visits** `(id, tenant_id, lead_id, project_id, scheduled_at, status ['offered','booked','confirmed','visited','no_show','cancelled'], assigned_rep_id, created_at, updated_at)`

- **whatsapp_messages** `(id, tenant_id, lead_id, direction, template_name, payload jsonb, status, provider_message_id, created_at)`

- **usage_records** `(id, tenant_id, period, metric ['calls','minutes','whatsapp_messages','llm_tokens'], quantity, cost_amount, created_at)` — feeds billing
- **audit_logs** `(id, tenant_id, actor_id, actor_type ['user','system','ai_agent'], action, entity_type, entity_id, metadata jsonb, created_at)`

### Key relationships

- `tenants 1—N users, roles, sales_reps, projects, leads, calls, integrations, ai_agents, usage_records`
- `projects 1—N project_configurations, leads, site_visits`
- `leads 1—N calls, site_visits, whatsapp_messages, lead_status_history`
- `calls 1—1 conversations`
- `leads N—1 sales_reps (assigned_rep_id)`

### Isolation rule (non-negotiable, per brief rule 2)
Every repository function signature starts with `tenantId: string`, and every table above (except `tenants` itself) has a `tenant_id` column with a composite index `(tenant_id, id)`. Row-level security (Postgres RLS) will be evaluated as a second enforcement layer on top of application-level scoping, not a replacement for it.

---

## D. Integration Boundaries

Every external system sits behind an interface in `packages/*-adapter`, implemented by a provider-specific class, selected via config/DI — never referenced by concrete type in business logic.

- **Telephony** — `ITelephonyProvider` (`packages/telephony-adapter`)
  - Methods: `initiateCall`, `onMediaStream`, `sendAudioFrame`, `hangup`, `getCallStatus`
  - V1 implementation: `ExotelAgentStreamProvider`
  - Nothing in `modules/calls` imports Exotel's SDK/types directly.

- **AI providers** — three separate interfaces in `packages/ai-adapter`:
  - `ISpeechToText` → `SarvamSaarasSTT`
  - `ILanguageModel` → `Sarvam105BLLM` (tool-calling contract defined here)
  - `ITextToSpeech` → `SarvamBulbulTTS`
  - The LLM adapter only ever receives a fixed `AiTool[]` list (from `packages/ai-tools`) and returns structured tool-call requests — it never receives DB credentials or raw SQL access. Tool *execution* happens in `apps/api`, invoking module services.

- **Messaging** — `IMessagingProvider` (`packages/messaging-adapter`) → `WhatsAppCloudProvider`.

- **Lead sources** — `ILeadSourceProvider` under `modules/integrations` → `MetaLeadAdsProvider` (webhook receiver + lead-sync).

- **Calendar** (later phase) — `ICalendarProvider` → `GoogleCalendarProvider`, consumed by `modules/site-visits`.

- **Object storage** — `IObjectStorage` (`packages/db` or its own `packages/storage-adapter`) → S3-compatible implementation, for recordings/exports.

- **AI tool layer** (critical boundary, brief rules 3–4): the LLM never sees connection strings or table names. Each tool in the list (`get_project_details`, `book_site_visit`, `update_lead`, etc.) is a typed function in `packages/ai-tools` that calls a module **service** (not repository directly), so normal business validation/authorization still applies even when the caller is the AI.

---

## E. Local Development Requirements

- **Node.js** LTS (20.x+), **pnpm** (workspace manager)
- **Docker Desktop** — for local Postgres + Redis (and later MinIO for S3-compatible storage) via `docker-compose.yml`
- **PostgreSQL 15+** (containerized locally; Supabase Postgres for hosted dev/staging if desired)
- **Redis 7+** (containerized) for BullMQ
- No GPU required (per brief rule 11) — all AI calls are hosted API calls (Sarvam), nothing runs local inference.
- **ngrok or similar tunnel** will eventually be needed for local webhook testing (Meta Lead Ads, WhatsApp, Exotel) — not required for this foundation step.
- Env var management: a single `.env.example` at the repo root enumerating everything below; each app loads/validates its own subset via `packages/config` (zod schema, fails fast on missing vars).

### Anticipated environment variables (names only — no values/keys created now)

```
# App
NODE_ENV=
PORT_API=
PORT_WEB=
APP_BASE_URL=

# Database
DATABASE_URL=
SUPABASE_URL=            # if Supabase used for auth/postgres
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis / Queue
REDIS_URL=

# Auth
JWT_SECRET=
SESSION_SECRET=

# Telephony (Exotel)
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
EXOTEL_SUBDOMAIN=
EXOTEL_ACCOUNT_SID=
EXOTEL_AGENTSTREAM_WEBHOOK_SECRET=

# AI (Sarvam)
SARVAM_API_KEY=
SARVAM_STT_MODEL=
SARVAM_LLM_MODEL=
SARVAM_TTS_MODEL=

# WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=

# Meta Lead Ads
META_APP_ID=
META_APP_SECRET=
META_LEAD_ADS_WEBHOOK_VERIFY_TOKEN=

# Google Calendar (later phase)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Object Storage (S3-compatible)
S3_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_REGION=

# Observability
SENTRY_DSN=
LOG_LEVEL=
```

Secrets storage principle (brief rules 7–8): local dev uses `.env` (gitignored); staging/prod uses the hosting platform's encrypted secret store or a dedicated secrets manager — never committed, never hard-coded, never logged.

---

## F. Phase-by-Phase Implementation Plan

**Phase 0 — Foundation (this task)**
Repo structure, this document, workspace tooling config. No code yet.

**Phase 1 — Scaffolding**
Initialize pnpm workspace, `apps/web` (blank Next.js), `apps/api` (blank Express/Fastify skeleton), `apps/worker` (blank BullMQ skeleton), shared `packages/*` stubs with just interfaces/types. `docker-compose.yml` for Postgres+Redis. Env schema + loader. No business logic.

**Phase 2 — Core multi-tenant data model**
DB schema (Prisma/Drizzle) for tenants, users, roles, auth. Tenant-scoped repository base class. Auth module (login/session). Audit log plumbing.

**Phase 3 — Leads & Projects domain**
Projects, project_configurations, leads, lead_status_history, lead state machine, sales_reps + assignment. Basic dashboard CRUD screens.

**Phase 4 — Queue & telephony skeleton**
BullMQ queues for call dialing/retry. `ITelephonyProvider` interface + a mock/stub implementation (no real Exotel yet) to prove the queue → dial → status-update loop end to end.

**Phase 5 — AI adapter skeleton**
`ISpeechToText`/`ILanguageModel`/`ITextToSpeech` interfaces + mock implementations. `packages/ai-tools` with tool interfaces wired to real module services (get_project_details, update_lead, etc.) but no live Sarvam calls yet.

**Phase 6 — Real Exotel integration**
Implement `ExotelAgentStreamProvider`, live webhook/media-stream handling, replace mock.

**Phase 7 — Real Sarvam integration**
Implement Saaras/105B/Bulbul adapters, wire the live call pipeline (STT→LLM→TTS) using the tool layer from Phase 5.

**Phase 8 — Site visits, WhatsApp, Meta Lead Ads**
Booking/reschedule/cancel logic + slot management; WhatsApp Cloud API send/receive; Meta Lead Ads webhook ingestion → lead creation.

**Phase 9 — Usage/billing & observability**
Usage metering, cost aggregation, Sentry, structured logging, health checks/metrics.

**Phase 10 — Hardening & production deployment**
RLS review, load testing of call concurrency, secrets migration to production store, deployment pipeline.

---

## Open Decisions for Your Approval

1. **ORM**: Prisma vs. Drizzle for `packages/db` — recommend **Drizzle** (lighter, closer to SQL, easier to enforce tenant-scoping patterns explicitly) but Prisma is a fine default if the team prefers its DX.
2. **Auth**: Supabase Auth vs. custom JWT — recommend **Supabase Auth** to save time, provided tenant isolation is still enforced at the application/service layer (not relying solely on Supabase RLS).
3. **API framework**: Fastify vs. Express for `apps/api` — recommend **Fastify** for built-in schema validation and better WebSocket ergonomics.
4. **Workspace tool**: pnpm workspaces alone vs. + Turborepo — recommend **Turborepo** once there are enough packages to benefit from task caching; not required at Phase 1.

Nothing above has been implemented. Awaiting your approval before starting Phase 1 scaffolding.
