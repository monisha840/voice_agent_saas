/**
 * Runs ONE simulated call against an already-running API (mock providers)
 * and prints the evidence: call, transcript, summary, lead, site visit.
 *
 * Usage: pnpm demo:call [leadName]      (API must be running: pnpm dev:api)
 * Env:   API_URL (default http://127.0.0.1:4000)
 */
const API = process.env.API_URL ?? "http://127.0.0.1:4000";

interface Json {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

// Session cookie from the dev-only demo login (the API requires a login for everything).
let cookie = "";

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init?.headers as Record<string, string> | undefined) } });
  return { status: res.status, body: (await res.json()) as Json };
}

async function main() {
  const login = await fetch(`${API}/api/auth/demo-login`, { method: "POST" });
  if (!login.ok) throw new Error(`Demo login failed (HTTP ${login.status}). Is DEMO_LOGIN_ENABLED on and the DB seeded (pnpm db:seed)?`);
  cookie = login.headers.getSetCookie()[0].split(";")[0];

  const wanted = process.argv[2];
  const leads = (await api("/api/leads")).body.data as Json[];
  const lead = wanted ? leads.find((l) => l.name === wanted) : leads[0];
  if (!lead) throw new Error(`No lead found${wanted ? ` named "${wanted}"` : ""}. Run pnpm db:seed first.`);
  console.log(`\n1. Lead: ${lead.name} (${lead.id}) status=${lead.status}`);

  const created = await api(`/api/leads/${lead.id}/call`, { method: "POST" });
  console.log(`2. POST /api/leads/:id/call -> HTTP ${created.status}`, JSON.stringify(created.body.data));
  if (created.status !== 202) throw new Error("call was not accepted");
  const callId = created.body.data.callId as string;

  let call: Json = {};
  for (let i = 0; i < 120; i++) {
    call = (await api(`/api/calls/${callId}`)).body.data;
    // Finalization (summary) runs in the background after the completed callback.
    if (call.status === "failed" || (call.status === "completed" && call.conversation?.summary)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`3. Call status: ${call.status} (started ${call.startedAt}, ended ${call.endedAt})`);

  console.log("4. Transcript:");
  for (const t of call.conversation?.transcript ?? []) console.log(`   ${String(t.speaker).toUpperCase().padEnd(4)} ${t.text}`);
  console.log(`5. Summary: ${call.conversation?.summary}`);
  console.log(`   Qualification: ${JSON.stringify(call.conversation?.qualification)}`);

  const after = (await api(`/api/leads/${lead.id}`)).body.data;
  console.log(`6. Lead now: status=${after.status} config=${after.requirementConfig} budget=${after.budgetMin}-${after.budgetMax}`);
  console.log(`7. Site visits: ${JSON.stringify(after.siteVisits)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
