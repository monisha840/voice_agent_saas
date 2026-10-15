/**
 * Tiny in-process metrics registry (counters and gauges) rendered in the Prometheus text format by GET /metrics.
 *
 * Deliberately small and safe by construction:
 *  - every metric is declared up front (name, help, label names); an unknown label throws, series are never created
 *    for unknown metrics;
 *  - label VALUES are restricted to short [a-z0-9_.:-] tokens, anything else becomes "other", and each metric keeps
 *    at most MAX_SERIES series (overflow collapses into "other"). So IPs, emails, ids and tokens cannot reach the
 *    output even by mistake, and memory is bounded;
 *  - state is per process: a restart resets counters (Prometheus rate()/increase() handle resets), and N instances
 *    are N scrape targets.
 */

export type MetricKind = "counter" | "gauge";

interface MetricDef {
  kind: MetricKind;
  help: string;
  labels: readonly string[];
}

const MAX_SERIES = 50;
const LABEL_VALUE = /^[a-z0-9_.:-]{1,48}$/;

const DEFS = {
  rate_limit_backend_errors_total: { kind: "counter", help: "Rate-limit counter store errors by failure mode.", labels: ["mode"] },
  rate_limit_fail_open_total: { kind: "counter", help: "Requests served WITHOUT rate limiting because the store failed (fail-open).", labels: [] },
  stream_auth_denied_total: { kind: "counter", help: "Media stream authentication denials by reason code.", labels: ["reason"] },
  stream_claim_conflicts_total: { kind: "counter", help: "Media stream claim conflicts (local, db, lost).", labels: ["kind"] },
  db_authorization_errors_total: { kind: "counter", help: "Database permission / row-level security errors seen by the central error handler.", labels: [] },
  db_runtime_role_problems: { kind: "gauge", help: "Number of problems the startup database role check found (0 = healthy).", labels: [] },
  db_role_check_failures_total: { kind: "counter", help: "Startup database role checks that found problems or could not run.", labels: ["kind"] },
  security_event_retention_errors_total: { kind: "counter", help: "Security event retention runs that failed.", labels: [] },
  security_event_retention_purged_total: { kind: "counter", help: "Security events purged by the retention job.", labels: [] },
  security_event_persist_failures_total: { kind: "counter", help: "Security events that could not be written to the database.", labels: [] },
  security_janitor_failures_total: { kind: "counter", help: "Security janitor task failures by task.", labels: ["task"] },
  security_janitor_last_success_timestamp_seconds: { kind: "gauge", help: "Unix time of the last fully successful janitor cleanup.", labels: [] },
  auth_throttle_denied_total: { kind: "counter", help: "Login / MFA attempts refused by the throttle.", labels: ["kind"] },
  process_start_time_seconds: { kind: "gauge", help: "Unix time this process started.", labels: [] },
} as const satisfies Record<string, MetricDef>;

export type MetricName = keyof typeof DEFS;

const series = new Map<MetricName, Map<string, number>>();

/**
 * Known label values, exported at 0 from the first scrape. Prometheus increase() cannot see the very first
 * increment of a series that did not exist before (no baseline sample), which would hide the first fail-open /
 * denial / janitor failure after a restart. Seeding gives every known series a baseline. Values outside this list
 * still work but their first increment is invisible to increase() (documented in monitoring.md).
 */
const SEED: Partial<Record<MetricName, readonly string[]>> = {
  rate_limit_backend_errors_total: ["open", "closed"],
  stream_claim_conflicts_total: ["local", "db", "lost"],
  security_janitor_failures_total: ["cleanup", "retention"],
  auth_throttle_denied_total: ["login", "mfa"],
  db_role_check_failures_total: ["problems", "inspect_error"],
  stream_auth_denied_total: [
    "unauthorized", "token_required", "token_reused",
    "token_missing", "token_malformed", "token_unknown_key", "token_bad_signature", "token_expired",
    "token_not_yet_valid", "token_wrong_issuer", "token_wrong_audience", "token_wrong_type", "token_bad_claims",
    "grant_required", "grant_malformed", "grant_unknown", "grant_expired", "grant_reused",
    "grant_call_missing", "grant_call_mismatch",
  ],
};

function seedSeries(): void {
  for (const [name, values] of Object.entries(SEED) as [MetricName, readonly string[]][]) {
    const label = DEFS[name].labels[0];
    const map = new Map<string, number>();
    for (const v of values) map.set(`${label}="${v}"`, 0);
    series.set(name, map);
  }
}
seedSeries();

function cleanValue(v: string): string {
  return LABEL_VALUE.test(v) ? v : "other";
}

function keyFor(name: MetricName, labels: Record<string, string>): string {
  const def: MetricDef = DEFS[name];
  return def.labels.map((l) => `${l}="${cleanValue(String(labels[l] ?? ""))}"`).join(",");
}

function slot(name: MetricName, labels: Record<string, string>): { map: Map<string, number>; key: string } {
  const def: MetricDef = DEFS[name];
  for (const l of Object.keys(labels)) if (!def.labels.includes(l)) throw new Error(`metric ${name}: unknown label ${l}`);
  let map = series.get(name);
  if (!map) series.set(name, (map = new Map()));
  let key = keyFor(name, labels);
  if (!map.has(key) && map.size >= MAX_SERIES - 1) key = def.labels.map((l) => `${l}="other"`).join(",");
  return { map, key };
}

export const metrics = {
  inc(name: MetricName, labels: Record<string, string> = {}, by = 1): void {
    if (DEFS[name].kind !== "counter" || !(by >= 0) || !Number.isFinite(by)) return;
    const { map, key } = slot(name, labels);
    map.set(key, (map.get(key) ?? 0) + by);
  },
  set(name: MetricName, value: number, labels: Record<string, string> = {}): void {
    if (DEFS[name].kind !== "gauge" || !Number.isFinite(value)) return;
    const { map, key } = slot(name, labels);
    map.set(key, value);
  },
  /** Current value (tests / diagnostics). Missing series read as 0. */
  get(name: MetricName, labels: Record<string, string> = {}): number {
    return series.get(name)?.get(keyFor(name, labels)) ?? 0;
  },
  names(): MetricName[] {
    return Object.keys(DEFS) as MetricName[];
  },
  render(): string {
    const out: string[] = [];
    for (const name of Object.keys(DEFS) as MetricName[]) {
      const def: MetricDef = DEFS[name];
      out.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} ${def.kind}`);
      const map = series.get(name);
      if (map && map.size > 0) {
        for (const [key, v] of map) out.push(`${name}${key ? `{${key}}` : ""} ${v}`);
      } else if (def.labels.length === 0) {
        out.push(`${name} 0`); // unlabelled series are always present so increase() has a baseline
      }
    }
    return out.join("\n") + "\n";
  },
  /** Test helper. */
  reset(): void {
    series.clear();
    seedSeries();
    metrics.set("process_start_time_seconds", Math.floor(Date.now() / 1000));
  },
};

metrics.set("process_start_time_seconds", Math.floor(Date.now() / 1000));

/** True for PostgreSQL privilege / row-level-security failures (also when wrapped as a `cause`). */
export function isDbAuthorizationError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === "42501") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (msg.includes("row-level security") || msg.includes("permission denied")) return true;
  return isDbAuthorizationError(e.cause, depth + 1);
}
