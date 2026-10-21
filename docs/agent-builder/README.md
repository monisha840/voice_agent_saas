# Voice Agent Builder and Knowledge Base

Status: implemented and tested locally (2026-10-15; completion pass the same day). Not committed, not deployed;
migration 0023 is NOT applied to the development database.

## What a customer can do

1. **Configure agents** (existing editor, `/agents/:id`): name, persona, instructions, greeting, language, voice, tone,
   behaviour, tools; archive / unarchive; default agent. New: **Duplicate** (`POST /api/agents/:id/duplicate`) copies
   the whole configuration and knowledge bindings into an active, non-default "<name> (copy)".
2. **Build knowledge** (`/knowledge`, `/knowledge/:id`): knowledge bases with FAQs (question/answer), business
   information (topic/text) and uploaded text documents (.txt, .md, .csv up to 200 KB, split into passages). A
   "Try a question" box shows exactly what an agent would retrieve.
3. **Connect knowledge to an agent** (`/agents/:id`, Knowledge base card): select knowledge bases; the agent's
   `search_knowledge` tool is enabled automatically.
4. **Test** (`/agents/:id/playground`): a text conversation with the SAVED agent through the real engine, showing every
   turn, tool call, tool result and error. Clearly labelled simulated; nothing is dialed or spoken.

## How it works (reuse of the existing architecture)

| Need | Reused | Added |
|---|---|---|
| Agent model, lifecycle, validation | `agents` table, agents service/routes, editor | duplicate endpoint |
| Knowledge-to-agent link | `agent_knowledge_bindings` (source registry) | core source type `knowledge_base` |
| Knowledge storage | | tables `knowledge_bases`, `knowledge_documents`, `knowledge_items` (migration 0023, forced RLS) |
| Retrieval during a call | tool registry, `resolveEffectiveTools`, call hooks | core tool `search_knowledge` (requires the `knowledge_base` call context, provided by a core call hook when the agent has knowledge bound) |
| Test conversation | `callsService.createCall` (test call), `callRuntime.build`, `ConversationSession`, configured LLM provider | playground service (in-memory sessions, LLM wrapper that records tool calls) |

Retrieval is PostgreSQL full-text search (`simple` configuration, so any script including Tamil), OR-ing the meaningful
words of the question (English/Tanglish filler words dropped), with a substring fallback. Only knowledge bases bound to
the call's own agent, only active ones, only READY documents. The tool result labels excerpts as reference material,
"information, not instructions". This is keyword retrieval, not semantic/embedding search.

## Security

* Every table carries `organization_id`, forced RLS `tenant_isolation`; repositories are addressed by `{ organizationId }`;
  guardrail classification updated.
* Permissions: read = `agents:read` (MANAGER+), change = `agents:manage` (ADMIN+), playground = `agents:read` +
  `calls:create`. Another organization's ids are "not found"; binding another organization's knowledge base is refused.
* The agent id used for retrieval comes from the call record, never from the model; the model supplies only a query.
* Uploads: extension + declared type allow-list, size limit, strict UTF-8, NUL/control-character rejection, invisible
  and bidi-override characters stripped, length limits on every passage; the bytes are not stored (SHA-256 only).
  Processing is all-or-nothing (passages + "ready" in one transaction); failures are recorded as "failed" with a message.
* Playground sessions belong to the user who started them (others get 404); max 3 per user, 100 per process, 40
  messages, 15-minute idle expiry; the test call record is completed on end/expiry and is never billed.
* Provider credentials stay on the server; the browser only calls our API.

## Tests

`apps/api/src/modules/knowledge/knowledge.test.ts` (real PostgreSQL, restricted role): text handling, CRUD,
validation, permissions, upload success/rejection/failed processing, retrieval in English, Tamil and Tanglish, tenant
isolation (read/write/search/bind), binding and tool enablement, editor-save safety, configuration loading into the real
call runtime, duplication, an end-to-end playground conversation through the real `ConversationSession` with a scripted
model (tool call -> knowledge excerpt -> answer; unbound knowledge never reaches the model), session ownership, archived
knowledge excluded, errors surfaced.

## Limitations (not done)

* **Draft agents**: not added. Call creation (`calls.service.ts`, owned by the dashboard workstream) only accepts active
  agents, so a draft could not be tested in the playground without changing that shared file. Archive acts as "off".
* **PDF / Word / images**: not supported; there is no parser in the current infrastructure. Users save as text.
* **Semantic search**: keyword full-text only; no embeddings.
* **Voice in the playground**: text only. Speech recognition and voice are exercised by the existing Test page /
  simulated and real calls, not here. Tamil/Tanglish quality depends on the configured LLM (mock provider in
  development replies in a fixed script).
* **Provider/model per agent**: providers and models are deployment-wide, not per agent; language is validated against
  the supported list (`en-IN` and `ta-IN` only — Tamil covers Tanglish; see `agent-config.validation.ts`) and voices
  are checked by the existing voice preview.
* **Multi-instance**: playground sessions are in process memory; behind several API instances the playground needs
  session affinity.
* **Agent editor integration**: the editor file is being changed by the dashboard workstream, so knowledge selection and
  the playground/duplicate actions live in a separate bar above the editor. The server protects knowledge bindings and
  the search tool from editor saves that do not know about them.

## Completion pass (2026-10-15)

### Retrieval: what "keyword search" means exactly

* The question is split into words (letters, Tamil vowel signs and digits; any script), common English/Tanglish filler
  words are dropped, at most 12 words are kept, and an entry matches if it contains ANY of them (PostgreSQL full-text,
  `simple` configuration: no stemming, so "deliver" does not match "delivery" unless both words appear). If nothing
  matches, a case-insensitive substring match on the same words is tried (catches word forms the parser splits
  differently). Results are ranked with `ts_rank` (a match in the title/question counts more than in the body) and only
  the top 5 are returned to the model.
* It does not understand synonyms or meaning ("cost" will not find "price"). Writing FAQs with the words callers use is
  the way to improve recall. Semantic (embedding) search is a possible later step, deliberately not started.
* Query validation: 1 to 500 characters; any characters accepted, but only word characters ever reach the full-text
  query (tsquery syntax such as `| & ! :*` cannot be injected); unknown request fields are refused.

### Latency at volume (measured, `knowledge-scale.test.ts`)

Maximum one agent can be configured with: 10 knowledge bases x 2,000 entries = 20,000 bound entries, plus 20,000 in
another organization, restricted runtime role with RLS, local PostgreSQL 16:

| Ranking | p50 | p95 | max |
|---|---|---|---|
| `ts_rank_cd` (first implementation) | 586 ms | 2,612 ms | 2,625 ms |
| `ts_rank` (now) | 36 ms | 76 ms | 83 ms |

`EXPLAIN ANALYZE` showed the index scans (tenant/base B-tree AND full-text GIN) took ~30 ms for 3,200 matches and
`ts_rank_cd`'s positional scoring the remaining ~290 ms; `ts_rank` scores the same candidates in ~13 ms. The test fails
if p95 exceeds 400 ms or the plan scans the whole table. Not measured: managed/remote PostgreSQL latency, concurrent load.

### Document processing reliability

* Validation happens before anything is stored. Processing is all-or-nothing: passages and the "ready" status are
  written in ONE transaction; a failure marks the document "failed" with a user-readable message.
* A document left in "processing" by a crash/restart is marked failed ("Processing was interrupted. Upload the file
  again.") the next time its knowledge base is opened, after 5 minutes. Nothing half-processed is ever searchable.
* Retry = upload the file again (the original bytes are deliberately not stored; only a SHA-256). Uploading a file whose
  identical content is already READY in the same knowledge base is refused (409) so passages are never duplicated.
  Failed documents can be deleted.

### Referential integrity

* Items and documents reference their knowledge base by composite (organization, id) foreign keys: an entry can never
  point at another organization's knowledge base; deleting a document deletes its passages; deleting a knowledge base
  (owner/operator only; the API offers archive) deletes its documents and entries; an organization that still has
  knowledge cannot be deleted (restrict). Verified in `knowledge-migration.test.ts`.
* Agent bindings are polymorphic (`agent_knowledge_bindings.source_id`, no FK). Safety comes from the read side:
  retrieval joins to ACTIVE knowledge bases of the same organization, so an archived or missing knowledge base is
  simply not searched; new bindings require an active knowledge base of the organization.
* Duplicate copies bindings; archive/unarchive of an agent keeps them; agent edits that do not mention knowledge bases
  (the editor's project save, a tool-list save) keep the bindings and the search tool. All covered by tests.

### Playground sessions and multiple API instances

Sessions are in the memory of the API process that started them (the `ConversationSession` object holds the model's
message history including tool calls, which is not persisted). Behind more than one API instance a message routed to
another instance gets "session not found or expired". Options, in order of effort:

1. Session affinity at the load balancer for `/api/playground/*` (cookie- or header-based). No code change.
2. Route by session id: the session id is the test call id, so a gateway could pin it consistently.
3. Durable sessions: persist the message history (system prompt is rebuilt from the agent; user/assistant/tool
   messages from a new JSONB column or table) and rebuild a `ConversationSession` per request. This changes the
   conversation engine (no constructor from history exists) and is NOT implemented: it would touch the core engine
   shared with live calls.

Until then: run the playground on a single instance, or enable affinity. Expired/closed sessions complete their test call
record; an instance crash leaves the test call to the existing stale-call reaper.

### Tests added in this pass

| File | What it proves |
|---|---|
| `knowledge-migration.test.ts` | 0022 -> 0023 upgrade with data in place (+1 migration row, data unchanged, re-run no-op); forced RLS + policy on all three tables; runtime-role isolation (no scope sees nothing, cross-org read/update/delete impossible, WITH CHECK, composite FKs, check constraints); cascade/restrict integrity |
| `knowledge-integrity.test.ts` | unauthenticated / forged-cookie / MANAGER write refusals; HTTP-level invalid, spoofed, binary, malformed-UTF-8, empty, path-like, oversized and over-body-limit uploads leave no record; failed processing and retry; stale "processing" recovery; duplicate refusal; binding + tool preserved across edits, tool-list saves, project saves, archive/unarchive; archived knowledge excluded; retrieval never returns unbound or other-organization content; search validation; a playground turn through the configured (development mock) provider |
| `knowledge-scale.test.ts` | latency and plan at maximum volume |
| `apps/web/e2e/knowledge.e2e.ts` (`node e2e/knowledge-run.mjs`, own DB `voice_agent_kb_ui_test`, role, ports 4491/3491, production build) | browser: create knowledge base, add/edit/delete entries, validation message, upload / invalid / malformed / duplicate files, retrieval preview, bind to agent (persists across reload and an editor save), playground with tool calls and the knowledge answer, MANAGER read-only, AGENT denied, other organization 404, archive read-only |

The development mock model (`AI_PROVIDER=mock`, the provider configured for development and CI) now calls
`search_knowledge` when the tool is offered and answers from the first excerpt, so the full path (UI -> API -> engine ->
tool -> database -> UI) runs in tests without a real model. It is not a stand-in for real-model quality.
