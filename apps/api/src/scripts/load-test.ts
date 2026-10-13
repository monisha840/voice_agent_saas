/**
 * Concurrent-call load test (mock providers). Boots the real API in this process, places N simulated calls at once
 * through POST /api/calls (agent-first "test" calls; no leads or Sales module needed; real HTTP + WebSocket + Postgres), and reports:
 *   - how many calls completed / failed, and wall time;
 *   - per-turn latency percentiles taken from the "turn: finished" metrics the server already logs;
 *   - event-loop lag and memory while the calls ran.
 *
 * It measures OUR code under concurrency. The mock providers answer instantly, so it says nothing about Sarvam's speed.
 *
 * Usage:  pnpm --filter @voice-agent/api load:test [calls=20] [turnsPerCall=4]
 * Needs:  Postgres up and seeded (pnpm db:up, db:migrate, db:seed). Uses the demo login. Leaves N completed test calls
 *         in the demo organization (they appear on the Calls page).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

const CALLS = Math.max(1, Number(process.argv[2] ?? 20));
const TURNS = Math.max(1, Number(process.argv[3] ?? 4));

// Mock providers, and the cost guards out of the way (they are what the load test would otherwise trip).
process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";
process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
process.env.MAX_CONCURRENT_CALLS_PER_ORG = String(CALLS + 10);
process.env.QUOTA_CALLS_PER_ORG_PER_DAY = "10000000";
process.env.QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH = "0";
process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = String(CALLS + 10);
process.env.RATE_LIMIT_API_MAX = "1000000";
process.env.MAX_CALL_DURATION_MS = "0";
process.env.SILENCE_TIMEOUT_MS = "0";
process.env.TURN_END_SILENCE_MS ??= "300";

const { loadEnv } = await import("../config/env.js");
loadEnv();

// Collect the per-turn metrics the handler logs, and keep the console quiet.
const turnMetrics: Array<Record<string, unknown>> = [];
let errorLines = 0;
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
console.log = (line: unknown) => {
  if (typeof line !== "string" || !line.includes('"turn: finished"')) return;
  try {
    turnMetrics.push(JSON.parse(line));
  } catch {
    // not ours
  }
};
console.warn = () => undefined;
console.error = () => {
  errorLines += 1;
};

const { buildApp } = await import("../app.js");
const { setTelephonyProvider } = await import("../adapters/telephony/index.js");
const { MockTelephonyProvider } = await import("../adapters/telephony/mock.provider.js");
const { sql } = await import("../db/client.js");
const { demoContext } = await import("../test/helpers.js");
const { defaultAgentIdFor } = await import("../test/tenants.js");

const DEFAULT_TURNS = [
  "Hi, I'm interested in the Green Valley Residency project.",
  "I'm looking for a 2 BHK. My budget is around 70 lakhs.",
  "I would like to visit on Saturday morning.",
  "11:30 AM works for me.",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stats(name: string, values: unknown[]): string {
  const v = values.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return `${name.padEnd(26)} (no samples)`;
  const f = (n: number) => String(Math.round(n)).padStart(6);
  return `${name.padEnd(26)} n=${String(v.length).padStart(4)}  p50=${f(percentile(v, 50))}  p95=${f(percentile(v, 95))}  max=${f(v[v.length - 1])} ms`;
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const login = await fetch(`${baseUrl}/api/auth/demo-login`, { method: "POST" });
  if (!login.ok) throw new Error(`demo login failed (HTTP ${login.status}); is the DB seeded and DEMO_LOGIN_ENABLED on?`);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { cookie, ...(init?.headers as Record<string, string>) } });
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
  };

  const org = await demoContext();
  const agentId = await defaultAgentIdFor(org.organizationId);

  const provider = new MockTelephonyProvider({ baseUrl, autoplay: true, customerTurns: DEFAULT_TURNS.slice(0, TURNS) });
  setTelephonyProvider(provider);

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let peakRss = 0;
  const rssTimer = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);

  const started = Date.now();
  const placed = await Promise.all(
    Array.from({ length: CALLS }, () => api("/api/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, callType: "test" }) })),
  );
  const accepted = placed.filter((r) => r.status === 202).length;
  if (accepted < CALLS) realError("rejected:", JSON.stringify(placed.find((r) => r.status !== 202)));
  const reports = await Promise.all(provider.simulations);
  const wallMs = Date.now() - started;

  // Give the background finalization (summary, usage) a moment, then read the final call states.
  await new Promise((r) => setTimeout(r, 1500));
  const statuses = new Map<string, number>();
  for (const r of placed) {
    if (r.status !== 202) continue;
    const call = (await api(`/api/calls/${r.body.data!.callId}`)).body.data as { status?: string } | undefined;
    statuses.set(call?.status ?? "unknown", (statuses.get(call?.status ?? "unknown") ?? 0) + 1);
  }

  clearInterval(rssTimer);
  lag.disable();
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;

  const ok = reports.filter((r) => r && r.protocolViolations.length === 0 && r.customerTurnsSent.length === TURNS).length;
  const userTurns = turnMetrics.filter((m) => m.kind === "user");
  console.log(`\nLoad test: ${CALLS} concurrent calls x ${TURNS} customer turns (mock providers)`);
  console.log(`  accepted by API       ${accepted}/${CALLS}`);
  console.log(`  simulations clean     ${ok}/${CALLS}  (all turns sent, no protocol violations)`);
  console.log(`  final call states     ${JSON.stringify(Object.fromEntries(statuses))}`);
  console.log(`  wall time             ${(wallMs / 1000).toFixed(1)} s`);
  console.log(`  server error lines    ${errorLines}`);
  console.log(`  event-loop lag        p50=${(lag.percentile(50) / 1e6).toFixed(1)}  p99=${(lag.percentile(99) / 1e6).toFixed(1)}  max=${(lag.max / 1e6).toFixed(1)} ms`);
  console.log(`  peak RSS              ${(peakRss / 1024 / 1024).toFixed(0)} MB`);
  console.log(`  turns measured        ${userTurns.length} caller turns, ${turnMetrics.length - userTurns.length} AI-initiated`);
  console.log(stats("  speech end -> 1st audio", userTurns.map((m) => m.speechEndToFirstAudioMs)));
  console.log(stats("  turn duration", userTurns.map((m) => m.turnMs)));
  console.log(stats("  LLM", userTurns.map((m) => m.llmMs)));
  console.log(stats("  TTS", userTurns.map((m) => m.ttsMs)));

  setTelephonyProvider(null);
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(accepted === CALLS && ok === CALLS && errorLines === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log = realLog;
  console.error = realError;
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
