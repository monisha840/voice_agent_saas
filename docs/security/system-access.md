# Privileged ("system") access: every workflow, why, and how it is restricted

The runtime has **no** unrestricted database access. A flow with no logged-in user derives its tenant from a
trusted record and then runs ordinary tenant-scoped statements. The only cross-tenant reads that exist are five
`SECURITY DEFINER` functions (migration 0012) that map a credential the caller already holds to an
organization id. Each is owned by `voice_resolver` (column-level SELECT only, no write), has a fixed
`search_path = pg_catalog, public`, takes one typed argument, and is executable by `voice_app` only (not PUBLIC).

| Function | Returns | Used by | Why it needs to run before a tenant is known | What restricts it |
|---|---|---|---|---|
| `app_resolve_call_org_by_provider_id(text)` | org id | status webhook, media stream (`call_sid`) | the provider names the call, not the organization | webhook shared secret (constant-time compare) checked before any DB work; result is the call's own owner, never a payload field |
| `app_resolve_call_org(uuid)` | org id | media stream (`internalCallId`), web call, simulator | stream URL carries our call id | same secret; web-call additionally requires the logged-in owner of that call |
| `app_resolve_phone_number_org(text)` | org id | inbound call routing | the dialed number decides agent **and** organization | number uniqueness constraint; callers cannot influence the result |
| `app_resolve_invitation_org(text)` | org id | public accept-invitation | the token is the credential | only unused, unexpired, unrevoked tokens resolve; token hash compared; uniform error for every failure |
| `app_resolve_project_org(uuid)` | org id | optional demo endpoint | single configured project id | endpoint off unless a 24+ char key is configured; private-host guard |
| `app_list_stale_calls(timestamptz, timestamptz)` | (call id, org id) rows | stale-call reaper (background) | sweeps all organizations | not reachable from any HTTP route; per-organization processing; summary recorded as `system.privileged_action` |

After resolution the repository calls `runInTenant({ organizationId })` and performs the real reads/writes with
the normal policies, so a bug in a system flow can still only touch the one organization it resolved.

## Flows that act as "system" inside a tenant

`systemContext(organizationId, source)` is built only from `call.organizationId` / `route.organizationId` /
`invitation.organizationId` (database records). `tenantScoped()` services and `ConversationSession` run every
statement of such a flow in that organization's scope. The set of sources is closed
(`exotel-webhook`, `media-stream`, `ai-tool`, `reaper`, `seed`, `simulator`, `telephony-inbound`, `test`).

## What ordinary requests cannot do

* No route reads an organization id from a body, query or path to choose a tenant: it comes from the
  authenticated membership (`req.ctx`). `security/guardrails.test.ts` and `tenant-isolation.test.ts` assert this
  (forged `organizationId` fields are ignored; foreign ids are 404).
* `systemLookups`, `runAsAdmin`, `adminDb` and `adminSql` may not be referenced outside the data layer and
  operator scripts (guardrail test).
* The administrative connection exists only when `DATABASE_ADMIN_URL` is set, which production startup
  validation refuses for the API runtime.

## Known limitation

Telephony endpoints are protected by one shared secret per deployment (Exotel's model). Anyone holding it can
address a call still waiting for its first stream by its `call_sid` (controls and residual risk:
`stream-tokens-and-dependencies.md` 3a); the effect is confined to that call's own organization, but a per-call signed
stream token would be stronger. Recommended before taking external traffic.
