/**
 * Report side of the STT provider benchmark (scripts/stt-benchmark.ts). Pure: turns raw per-run measurements into the
 * comparison table. It only ever formats numbers that were measured; a provider/language that was not run shows why
 * ("skipped: ..."), and a value that could not be measured shows "-". Nothing is estimated or filled in.
 */
export interface BenchRun {
  /** Speech start -> first partial (ms); undefined if no partial arrived. */
  firstPartialMs?: number;
  /** Speech end -> final (ms); undefined if no final arrived. */
  finalMs?: number;
  /** Speech start -> final (ms). */
  totalMs?: number;
  partials: number;
  emptyFinal: boolean;
  error?: string;
}

export interface BenchRow {
  provider: string;
  language: string;
  /** Free text such as "synthetic TTS audio" or "exploratory: unsupported language". Shown in the notes column. */
  note?: string;
  /** Present when the combination was not run at all. */
  skipped?: string;
  runs: BenchRun[];
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface BenchSummary {
  provider: string;
  language: string;
  note?: string;
  skipped?: string;
  runs: number;
  firstPartialMs?: number;
  finalMs?: number;
  totalMs?: number;
  worstFinalMs?: number;
  partialsPerRun?: number;
  emptyFinals: number;
  errors: number;
}

export function summarize(row: BenchRow): BenchSummary {
  const nums = (pick: (r: BenchRun) => number | undefined) => row.runs.map(pick).filter((v): v is number => v !== undefined);
  const finals = nums((r) => r.finalMs);
  return {
    provider: row.provider,
    language: row.language,
    note: row.note,
    skipped: row.skipped,
    runs: row.runs.length,
    firstPartialMs: median(nums((r) => r.firstPartialMs)),
    finalMs: median(finals),
    totalMs: median(nums((r) => r.totalMs)),
    worstFinalMs: finals.length ? Math.max(...finals) : undefined,
    partialsPerRun: row.runs.length ? Math.round((row.runs.reduce((n, r) => n + r.partials, 0) / row.runs.length) * 10) / 10 : undefined,
    emptyFinals: row.runs.filter((r) => r.emptyFinal).length,
    errors: row.runs.filter((r) => r.error).length,
  };
}

const ms = (v: number | undefined) => (v === undefined ? "-" : `${v} ms`);

/** The comparison table. Medians over the runs that produced a value; the run count is shown so thin data is visible. */
export function formatReport(rows: BenchRow[]): string {
  const header = ["Provider", "Language", "Runs", "First partial", "Final latency", "Total", "Worst final", "Partials", "Empty", "Errors", "Notes"];
  const body = rows.map((r) => {
    const s = summarize(r);
    if (s.skipped) return [s.provider, s.language, "0", "-", "-", "-", "-", "-", "-", "-", `skipped: ${s.skipped}`];
    return [
      s.provider,
      s.language,
      String(s.runs),
      ms(s.firstPartialMs),
      ms(s.finalMs),
      ms(s.totalMs),
      ms(s.worstFinalMs),
      s.partialsPerRun === undefined ? "-" : String(s.partialsPerRun),
      String(s.emptyFinals),
      String(s.errors),
      s.note ?? "",
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("-+-"), ...body.map(line)].join("\n");
}
