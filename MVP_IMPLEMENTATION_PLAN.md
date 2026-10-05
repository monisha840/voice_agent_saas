# MVP Implementation Plan — Real Estate Voice AI Demo

Status: **Plan only. No code written yet.**

Goal: one real, working vertical slice — lead → real AI phone call → real-time conversation → qualification → site-visit booking → transcript + summary → dashboard — demoable to the MD. Everything not needed to prove that loop is mocked, stubbed, or skipped. Multi-tenancy, billing, RBAC, and the other production concerns from `PROJECT_ARCHITECTURE.md` are **not built now**, but code is still organized so they can be added without a rewrite (see §2).

---

## 1. Exact User Journey (demo script)

1. MD opens the dashboard → sees **Green Valley Residency** project and a lead list (Rajesh Kumar + a few others).
2. MD clicks **Rajesh Kumar** → lead detail page: name, phone, requirement (2BHK, ₹60–80L budget), status = `NEW`.
3. MD clicks **Call Lead**.
4. Backend places a real outbound call via Exotel AgentStream to Rajesh's number (in the demo, this will be a real phone the team controls, acting as "Rajesh").
5. Call connects. AI agent, over the live audio stream:
   - Greets, introduces itself and the company, confirms the person can talk now.
   - Asks about requirement (confirms configuration/budget already on file, fills gaps).
   - Asks up to 3 qualification questions (e.g., timeline to buy, loan requirement, preferred location fit).
   - Answers any project questions (price, configurations, amenities, possession, location) strictly from `project_knowledge` data — never invents facts.
   - Offers a site visit; calls `check_visit_slots`; reads out 2–3 options.
   - Lead picks one; AI calls `book_site_visit`; confirms date/time back to the lead.
   - Closes the call naturally ("Thank you, see you then").
6. Call ends (either side hangs up, or AI calls `end_call`).
7. Backend (post-call):
   - Persists full transcript.
   - Calls the LLM once more to generate a structured summary + extracted qualification fields.
   - Updates lead status (`NEW` → … → `VISIT_BOOKED`, or `NOT_INTERESTED`/`FOLLOW_UP` if that's how it went).
   - Persists the site visit record if one was booked.
8. MD refreshes lead detail page → sees: call history entry, transcript, AI summary, updated status, qualification data, booked site visit.

This is the entire demo. Nothing else needs to exist.

---

## 2. MVP Architecture

Single deployable philosophy, but still split into two processes because telephony media-stream handling genuinely needs a persistent connection:

- **`apps/web`** — Next.js dashboard (project view, lead list, lead detail, "Call Lead" button, call/transcript/summary display).
- **`apps/api`** — Fastify REST API + WebSocket endpoint for Exotel's AgentStream media connection. Owns: lead/project/call data, the Exotel adapter, the Sarvam adapters, the AI tool layer, the live call orchestration loop (STT→LLM→TTS), post-call summary generation.

No `worker` app, no Redis/BullMQ **unless** the call-initiation step needs to be decoupled from the HTTP request (see below) — kept as a single guarded "if actually required" decision:

> **Decision: skip BullMQ for the MVP.** "Call Lead" triggers a direct async call to the Exotel "initiate call" API from the Fastify route handler; the route returns immediately once Exotel accepts the call request (not once the call finishes). The actual conversation runs inside the WebSocket handler when Exotel connects the media stream, fully decoupled from the original HTTP request already. There's no retry/backoff/scheduling requirement in the demo (one button, one call, no auto-retry on no-answer), so a queue adds infrastructure without adding demo value. The adapter interface is written so a queue can be inserted later (`CallQueue.enqueue(callJob)` as a drop-in replacement for the direct call) without changing calling code.

### Module boundaries (kept for future multi-tenant reuse, per your instruction)

```
apps/api/src/
├── modules/
│   ├── projects/            # Green Valley Residency + project_knowledge CRUD (read-mostly for MVP)
│   ├── leads/                # lead CRUD, status transitions
│   ├── calls/                 # call records, orchestration entry point, post-call pipeline
│   ├── conversations/         # transcript storage, turn log
│   ├── site-visits/            # slot checking (mocked calendar) + booking
│   └── ai-agent/               # prompt construction, conversation state machine, tool dispatch
├── adapters/
│   ├── telephony/
│   │   ├── telephony.interface.ts     # ITelephonyProvider
│   │   └── exotel.provider.ts         # real Exotel AgentStream implementation
│   ├── stt/
│   │   ├── stt.interface.ts           # ISpeechToText
│   │   └── sarvam-saaras.provider.ts
│   ├── llm/
│   │   ├── llm.interface.ts           # ILanguageModel (chat + tool-calling contract)
│   │   └── sarvam-105b.provider.ts
│   └── tts/
│       ├── tts.interface.ts           # ITextToSpeech
│       └── sarvam-bulbul.provider.ts
├── ai-tools/                  # typed tool implementations, call module services only
│   ├── get_project_details.ts
│   ├── get_project_price.ts
│   ├── get_project_configurations.ts
│   ├── get_project_location.ts
│   ├── check_visit_slots.ts
│   ├── book_site_visit.ts
│   ├── update_lead.ts
│   ├── mark_not_interested.ts
│   └── end_call.ts
├── websocket/
│   └── exotel-media-stream.handler.ts  # bridges Exotel audio frames ↔ STT/LLM/TTS loop
└── db/
    ├── schema (Drizzle or Prisma)
    └── repositories/            # one per entity, no raw SQL in services/routes
```

**No `tenant_id` columns in the MVP schema** — single demo tenant is implicit (one company, one project, hardcoded demo org). Repository method signatures are still written as `(params)` objects rather than positional args, and nothing hardcodes "there is only one company" in business logic — so adding a `tenantId` column + filter later is a schema migration + repository-signature change, not a redesign. This is the one deliberate simplification versus the production doc.

**AI never touches Postgres directly** — same rule as production. The LLM adapter gets a fixed tool list and returns tool-call requests; `ai-tools/*` execute against module services.

---

## 3. Required Database Tables (MVP only)

Minimal, no tenant_id, no billing/audit tables.

- **projects** `(id, name, location, status)`
- **project_knowledge** `(id, project_id, category ['pricing','configurations','amenities','possession','faq','location'], content jsonb)` — the approved data the AI may quote from
- **leads** `(id, project_id, name, phone, requirement_config, budget_min, budget_max, status, created_at, updated_at)`
  - status enum (trimmed lifecycle for MVP): `NEW → CALLING → ANSWERED → QUALIFICATION → INTERESTED/NOT_INTERESTED → VISIT_BOOKED → FOLLOW_UP`
  - (`NO_ANSWER`/`BUSY`/`RETRY`/`DNC`/`VISITED`/`NO_SHOW` modeled in the enum for forward-compat but not exercised by demo flow unless naturally hit)
- **calls** `(id, lead_id, provider_call_id, status, started_at, ended_at, recording_url nullable)`
- **conversations** `(id, call_id, transcript jsonb, summary text, qualification jsonb, created_at)`
  - `transcript`: ordered array of `{speaker, text, timestamp}`
  - `qualification`: extracted structured fields (timeline, loan_required, final_requirement_notes, etc.)
- **site_visits** `(id, lead_id, project_id, scheduled_at, status ['booked','cancelled'], created_at)`

That's it — 6 tables. `sales_reps`, `usage_records`, `audit_logs`, `integrations`, `users/roles` are **not created** for the MVP (single implicit admin user = the MD/demo operator, no login system needed unless you want a basic password gate on the dashboard — see Open Question below).

---

## 4. Required APIs (Fastify, `apps/api`)

```
GET    /api/projects/:id                      → project + knowledge base
GET    /api/leads                             → list leads (for dashboard list view)
GET    /api/leads/:id                         → lead detail incl. latest call/visit
POST   /api/leads/:id/call                    → "Call Lead" button; initiates Exotel outbound call
GET    /api/calls/:id                         → call status/transcript/summary (for polling or detail view)
GET    /api/leads/:id/calls                   → call history for a lead

# Exotel webhook / media-stream endpoints
POST   /api/telephony/exotel/status-callback  → call status updates (ringing/answered/completed)
WS     /api/telephony/exotel/media-stream     → bidirectional audio stream for the live call
```

No auth endpoints unless the Open Question below is answered "yes" — kept out by default per "do not over-engineer."

---

## 5. Required AI Tools (trimmed to what the demo flow uses)

| Tool | Purpose |
|---|---|
| `get_project_details` | General project info (location, possession, amenities) |
| `get_project_price` | Pricing for a configuration |
| `get_project_configurations` | Available unit types (1/2/3 BHK etc.) |
| `check_visit_slots` | Returns available slots (mocked slot generator — see §8) |
| `book_site_visit` | Books the chosen slot, creates `site_visits` row, updates lead status |
| `update_lead` | Persists qualification answers / requirement updates mid-call |
| `mark_not_interested` | If lead declines — sets status, ends qualification early |
| `end_call` | Signals the orchestration loop to close the call gracefully |

Dropped from the full production list for MVP: `get_project_location` (folded into `get_project_details`), `reschedule_site_visit`/`cancel_site_visit` (no rebooking flow in the demo script), `schedule_callback`, `send_whatsapp`, `assign_sales_rep`, `transfer_to_human`, `mark_dnc` — all are real production needs but not exercised by this one demo call script, and adding them later is additive (new files in `ai-tools/`), not a redesign.

---

## 6. Exotel Call Flow

1. `POST /api/leads/:id/call` → `calls.service` creates a `calls` row (`status: initiating`), calls `ExotelProvider.initiateCall({ to: lead.phone, callbackUrl, streamUrl })`.
2. Exotel places the PSTN call to the lead's phone.
3. Exotel sends status callbacks to `POST /api/telephony/exotel/status-callback` (`ringing` → `in-progress` → `completed`); each updates the `calls` row.
4. On answer, Exotel opens the AgentStream WebSocket connection to `WS /api/telephony/exotel/media-stream`, streaming the live call audio both directions.
5. `exotel-media-stream.handler.ts` owns the per-call session: receives inbound audio frames, buffers/segments them (VAD or fixed-interval chunking), hands chunks to the STT adapter, feeds resulting text into the conversation loop (§7), receives TTS audio back, writes it to the outbound stream.
6. On call end (hangup from either side, or `end_call` tool invoked), the handler closes the stream, finalizes the `calls` row (`status: completed`, `ended_at`), and triggers the post-call pipeline (transcript save already incremental; summary generation; lead status update).

`ExotelProvider` implements `ITelephonyProvider { initiateCall, handleStatusCallback, attachMediaStream }` — nothing elsewhere in the codebase imports Exotel-specific types.

---

## 7. Sarvam STT → LLM → TTS Flow (per call, inside the media-stream handler)

Turn-based loop, not full-duplex barge-in for MVP (simplification — explicitly flagged below):

1. Inbound audio chunk(s) accumulate until an end-of-utterance signal (simple VAD/silence threshold, or Exotel-provided speech-end event if available).
2. Buffered audio → `SarvamSaarasSTT.transcribe(audioBuffer)` → user utterance text.
3. Utterance appended to conversation state → sent to `Sarvam105BLLM.chat(messages, tools)` along with:
   - System prompt (agent persona + the 10-step script in §1)
   - Project knowledge relevant to the lead (injected as context, not fetched live by the LLM itself)
   - Full turn history for this call
   - The fixed MVP tool list (§5)
4. LLM responds with either plain text (next thing to say) or a tool-call request.
   - If tool-call: `ai-tools/<tool>.ts` executes against module services, result is fed back to the LLM as a tool result, loop continues until LLM produces spoken text.
5. Response text → `SarvamBulbulTTS.synthesize(text)` → audio → streamed back to Exotel outbound.
6. Each turn (user text, AI text, tool calls/results) appended to the in-memory transcript, persisted incrementally to `conversations.transcript` (so a dropped call still leaves partial data).
7. On `end_call` tool call or hangup: loop exits → post-call summary step runs one more LLM call: `Sarvam105BLLM.chat(summaryPrompt + full transcript)` → structured JSON `{summary, qualification: {...}, recommended_status}` → written to `conversations.summary`/`qualification` and `leads.status`.

**Flagged simplification:** no real-time barge-in/interruption handling in the MVP (lead can't talk over the AI mid-sentence and have it stop). This is a known gap versus production-grade voice UX; acceptable for a scripted demo call, called out explicitly so it's not mistaken for an oversight.

---

## 8. Demo Data

**Company (implicit, no tenant row):** "Green Valley Developers" (name used only in UI copy/greeting, not a DB row for MVP).

**Project:**
- Green Valley Residency — Location: Whitefield, Bangalore
- Configurations: 2 BHK (1150 sq ft), 3 BHK (1550 sq ft)
- Approx. pricing: 2 BHK ₹65L–₹78L, 3 BHK ₹95L–₹1.1Cr
- Amenities: clubhouse, swimming pool, gym, children's play area, 24x7 security
- Possession: Dec 2026
- FAQs: RERA status, loan assistance availability, booking amount, maintenance charges

**Leads (seed ~4–5):**
1. Rajesh Kumar — 2 BHK — ₹60L–₹80L — phone: (demo-controlled real number)
2. Priya Sharma — 3 BHK — ₹90L–₹1.2Cr
3. Anil Mehta — 2 BHK — ₹50L–₹65L
4. Sunita Rao — 3 BHK — ₹1Cr–₹1.3Cr

**Site visit slots:** `check_visit_slots` returns a mocked generator — next 3 weekday afternoons/weekend mornings at fixed times (no real calendar integration, as instructed). `book_site_visit` just writes the chosen slot to `site_visits`; no conflict-checking against other leads needed for the demo (single-threaded demo, not realistic multi-booking load).

All seed data loaded via a single `scripts/seed.ts` run against the local Postgres instance — not through the UI.

---

## 9. Implementation Phases

**Phase 1 — Scaffolding & data**
Next.js app shell, Fastify app shell, Postgres schema (6 tables), seed script with Green Valley + demo leads. No AI/telephony yet.

**Phase 2 — Dashboard read paths**
Lead list, lead detail, project view wired to real API reading seeded data. Proves the data layer and UI before any AI/telephony complexity.

**Phase 3 — Telephony adapter (real Exotel, call connects)**
`ExotelProvider.initiateCall`, status callback endpoint, media-stream WebSocket endpoint that just echoes/logs audio (no AI yet) — proves a real call connects end-to-end before adding AI complexity on top.

**Phase 4 — AI adapters (mocked or sandbox first)**
Sarvam STT/LLM/TTS adapter implementations, exercised with a text-only harness (no live call) to validate the conversation loop and tool-calling logic against the project knowledge and the 8 tools.

**Phase 5 — Live call orchestration**
Wire Phases 3+4 together inside `exotel-media-stream.handler.ts`: real call, real STT→LLM→TTS loop, tool execution, incremental transcript persistence.

**Phase 6 — Post-call pipeline**
Summary generation call, qualification extraction, lead status update, site-visit persistence confirmation.

**Phase 7 — Dashboard write-back & polish**
Call history, transcript view, summary view on lead detail; "Call Lead" button wired to Phase 3's endpoint; basic loading/call-in-progress state in UI.

**Phase 8 — Demo rehearsal**
Run the full script against a real phone, fix conversation/prompt issues, confirm transcript/summary/status/visit all show correctly in the dashboard.

---

## Open Questions for Your Approval

1. **Dashboard auth**: no login at all (open demo page) vs. a single hardcoded password gate? Recommend **no auth** for speed, since this is an internal demo on a controlled URL — flag if that's not acceptable.
2. **Phone number for "Rajesh Kumar"**: should be a real number your team controls, since the call is real. Please confirm who answers during the demo.
3. **Exotel account**: confirm you already have (or will provision) an Exotel account with AgentStream enabled and a number capable of outbound calling — this plan assumes credentials will be available by Phase 3.
4. **Sarvam access**: confirm API access/keys for Saaras, 105B, and Bulbul will be available by Phase 4 — if there's a waitlist/approval step, flag it now so it doesn't block Phase 5.

Nothing has been implemented. Awaiting your approval before Phase 1.
