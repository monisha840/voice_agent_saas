/**
 * Alert rules (docs/security/alert-rules.yml): static validation only. No Prometheus is run and nothing is delivered.
 * Checks: structure, unique names, every referenced metric exists in the registry output, and the threshold logic of
 * each expression on synthetic fixtures (a minimal evaluator for the exact forms used in the file).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metrics } from "./metrics.js";

const FILE = fileURLToPath(new URL("../../../../docs/security/alert-rules.yml", import.meta.url));

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  hasSeverity: boolean;
  hasSummary: boolean;
  hasAction: boolean;
}

/** Parses the small, regular subset of YAML this file uses (one `- alert:` block per rule). */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let cur: Rule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (line.startsWith("#")) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^- alert:\s*(\S+)/))) {
      cur = { alert: m[1], expr: "", hasSeverity: false, hasSummary: false, hasAction: false };
      rules.push(cur);
    } else if (cur && (m = line.match(/^expr:\s*(.+)$/))) cur.expr = m[1].trim();
    else if (cur && (m = line.match(/^for:\s*(\S+)/))) cur.for = m[1];
    else if (cur && /^labels:.*severity:\s*(warning|critical|none)/.test(line)) cur.hasSeverity = true;
    else if (cur && /^summary:\s*".+"/.test(line)) cur.hasSummary = true;
    else if (cur && /^action:\s*".+"/.test(line)) cur.hasAction = true;
  }
  return rules;
}

const METRIC_RE = /[a-z_][a-z0-9_]*(?:_total|_seconds|_problems)/g;
const referencedMetrics = (expr: string) => [...new Set(expr.match(METRIC_RE) ?? [])];

type Sample = { t: number; v: number };
type Fixture = Record<string, Sample[]>;

/** Expressions only promtool can evaluate (see alert-rules.test.yml): scrape health, changes(), constants. */
const isPromtoolOnly = (expr: string) => /^(up\{|changes\(|vector\()/.test(expr);
/** Rules that deliberately compare a counter's current value (it is set once at startup, before any scrape). */
const BARE_COUNTER_RULES = new Set(["DbRoleCheckFailed"]);

/**
 * Evaluates, against fixture samples at time `now`: `[sum [by (l)] (]increase(M[{sel}][W])[)] > N`, `M > N` (also
 * inside sum by) and `time() - (A > 0 or B) > N`. Label selectors are ignored here (fixtures are per metric name);
 * promtool covers them.
 */
function evaluate(exprIn: string, fx: Fixture, now: number): boolean {
  let m: RegExpMatchArray | null;
  let expr = exprIn;
  if ((m = expr.match(/^sum(?: by \([a-z_,\s]+\))?\s*\((.*)\)\s*(>\s*\d+)$/))) expr = `${m[1]} ${m[2]}`;
  if ((m = expr.match(/^time\(\)\s*-\s*\(([a-z0-9_]+)\s*>\s*0 or ([a-z0-9_]+)\)\s*>\s*(\d+)$/))) {
    const a = (fx[m[1]] ?? []).at(-1)?.v ?? 0;
    const last = a > 0 ? a : (fx[m[2]] ?? []).at(-1)?.v;
    return last !== undefined && now - last > Number(m[3]);
  }
  if ((m = expr.match(/^increase\(([a-z0-9_]+)(?:\{[^}]*\})?\[(\d+)([mhd])\]\)\s*>\s*(\d+)$/))) {
    const win = Number(m[2]) * { m: 60, h: 3600, d: 86400 }[m[3] as "m" | "h" | "d"];
    const pts = (fx[m[1]] ?? []).filter((s) => s.t >= now - win && s.t <= now).sort((a, b) => a.t - b.t);
    if (pts.length < 2) return false;
    let inc = 0;
    for (let i = 1; i < pts.length; i++) inc += pts[i].v >= pts[i - 1].v ? pts[i].v - pts[i - 1].v : pts[i].v; // counter reset
    return inc > Number(m[4]);
  }
  if ((m = expr.match(/^time\(\)\s*-\s*([a-z0-9_]+)\s*>\s*(\d+)$/))) {
    const pts = fx[m[1]] ?? [];
    return pts.length > 0 && now - pts[pts.length - 1].v > Number(m[2]);
  }
  if ((m = expr.match(/^([a-z0-9_]+)\s*>\s*(\d+)$/))) {
    const pts = fx[m[1]] ?? [];
    return pts.length > 0 && pts[pts.length - 1].v > Number(m[2]);
  }
  throw new Error(`unsupported expression form: ${expr}`);
}

const rules = parseRules(readFileSync(FILE, "utf8"));
const registryOutput = (() => {
  metrics.reset();
  return metrics.render();
})();

describe("alert-rules.yml", () => {
  it("has rules with unique names, severity, summary, action and an expression", () => {
    expect(rules.length).toBeGreaterThanOrEqual(10);
    expect(new Set(rules.map((r) => r.alert)).size).toBe(rules.length);
    for (const r of rules) {
      expect(r.expr, r.alert).not.toBe("");
      expect(r.hasSeverity, `${r.alert} severity`).toBe(true);
      expect(r.hasSummary, `${r.alert} summary`).toBe(true);
      expect(r.hasAction, `${r.alert} action`).toBe(true);
    }
  });

  it("declares an explicit for: on every rule, covers every required signal and has a heartbeat", () => {
    for (const r of rules) expect(r.for, `${r.alert} for`).toMatch(/^\d+[smh]$/);
    const text = readFileSync(FILE, "utf8");
    for (const metric of [
      "rate_limit_fail_open_total", "rate_limit_backend_errors_total", "stream_auth_denied_total",
      "stream_claim_conflicts_total", "db_authorization_errors_total", "db_runtime_role_problems",
      "db_role_check_failures_total", "security_event_retention_errors_total", "security_janitor_failures_total",
      "security_janitor_last_success_timestamp_seconds", "security_event_persist_failures_total",
      "auth_throttle_denied_total",
    ]) expect(text, metric).toContain(metric);
    expect(rules.map((r) => r.alert)).toEqual(expect.arrayContaining(["Watchdog", "MetricsTargetDown", "MfaThrottleSpike"]));
  });

  it("references only metrics the registry exposes", () => {
    for (const r of rules) {
      if (isPromtoolOnly(r.expr) && !r.expr.includes("process_start_time_seconds")) continue;
      const names = referencedMetrics(r.expr);
      expect(names.length, r.alert).toBeGreaterThan(0);
      for (const n of names) expect(registryOutput, `${r.alert} -> ${n}`).toContain(`# TYPE ${n} `);
    }
  });

  it("every counter used under increase() is a counter, every bare/time() metric a gauge", () => {
    for (const r of rules) {
      if (isPromtoolOnly(r.expr)) continue;
      const inc = r.expr.match(/increase\(([a-z0-9_]+)[[{]/)?.[1];
      if (inc) expect(registryOutput).toContain(`# TYPE ${inc} counter`);
      else if (BARE_COUNTER_RULES.has(r.alert)) expect(registryOutput).toContain(`# TYPE ${referencedMetrics(r.expr)[0]} counter`);
      else for (const n of referencedMetrics(r.expr)) expect(registryOutput).toContain(`# TYPE ${n} gauge`);
    }
  });

  it("each expression fires just above its threshold and stays quiet at/below it (fixture evaluation)", () => {
    const now = 1_800_000_000;
    for (const r of rules) {
      if (isPromtoolOnly(r.expr)) continue;
      const metric = referencedMetrics(r.expr)[0];
      const threshold = Number(r.expr.match(/>\s*(\d+)$/)?.[1]);
      expect(Number.isFinite(threshold), r.alert).toBe(true);
      if (r.expr.startsWith("time()")) {
        const [last, start] = referencedMetrics(r.expr);
        const at = (age: number) => ({ [last]: [{ t: now, v: now - age }], [start]: [{ t: now, v: now - 100_000 }] });
        expect(evaluate(r.expr, at(threshold + 1), now), `${r.alert} stale`).toBe(true);
        expect(evaluate(r.expr, at(threshold), now), `${r.alert} fresh`).toBe(false);
        // Never succeeded (gauge 0): falls back to process start, so only an old process fires.
        const neverOk = (up: number) => ({ [last]: [{ t: now, v: 0 }], [start]: [{ t: now, v: now - up }] });
        expect(evaluate(r.expr, neverOk(threshold + 1), now), `${r.alert} never succeeded, old process`).toBe(true);
        expect(evaluate(r.expr, neverOk(60), now), `${r.alert} never succeeded, new process`).toBe(false);
      } else if (r.expr.includes("increase(")) {
        const fire = { [metric]: [{ t: now - 30, v: 10 }, { t: now, v: 10 + threshold + 1 }] };
        const quiet = { [metric]: [{ t: now - 30, v: 10 }, { t: now, v: 10 + threshold }] };
        const reset = { [metric]: [{ t: now - 60, v: 500 }, { t: now - 30, v: 0 }, { t: now, v: threshold + 1 }] };
        expect(evaluate(r.expr, fire, now), `${r.alert} fire`).toBe(true);
        expect(evaluate(r.expr, quiet, now), `${r.alert} quiet`).toBe(false);
        expect(evaluate(r.expr, reset, now), `${r.alert} reset`).toBe(true);
      } else {
        expect(evaluate(r.expr, { [metric]: [{ t: now, v: threshold + 1 }] }, now), `${r.alert} fire`).toBe(true);
        expect(evaluate(r.expr, { [metric]: [{ t: now, v: threshold }] }, now), `${r.alert} quiet`).toBe(false);
      }
    }
  });
});
