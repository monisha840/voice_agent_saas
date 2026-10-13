import { describe, it, expect } from "vitest";
import { formatReport, median, summarize, type BenchRow } from "./stt-benchmark-report.js";

describe("STT benchmark report", () => {
  it("median handles odd, even and empty input", () => {
    expect(median([])).toBeUndefined();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 20, 30, 41])).toBe(25);
  });

  it("summarizes only what was measured: missing values stay undefined, never estimated", () => {
    const row: BenchRow = {
      provider: "P",
      language: "English",
      runs: [
        { firstPartialMs: 300, finalMs: 400, totalMs: 2400, partials: 4, emptyFinal: false },
        { firstPartialMs: undefined, finalMs: 600, totalMs: 2600, partials: 0, emptyFinal: false },
        { partials: 0, emptyFinal: false, error: "ProviderRequestError:timeout" },
        { firstPartialMs: 500, finalMs: 800, totalMs: 2800, partials: 2, emptyFinal: true },
      ],
    };
    expect(summarize(row)).toMatchObject({ runs: 4, firstPartialMs: 400, finalMs: 600, totalMs: 2600, worstFinalMs: 800, partialsPerRun: 1.5, emptyFinals: 1, errors: 1 });
    const none = summarize({ provider: "P", language: "L", runs: [{ partials: 0, emptyFinal: false, error: "x" }] });
    expect(none.firstPartialMs).toBeUndefined();
    expect(none.finalMs).toBeUndefined();
  });

  it("formats the comparison table; skipped rows say why and carry no numbers; notes are kept", () => {
    const text = formatReport([
      { provider: "Sarvam", language: "English", runs: [{ firstPartialMs: 250, finalMs: 410, totalMs: 2300, partials: 5, emptyFinal: false }] },
      { provider: "AssemblyAI", language: "English", runs: [{ firstPartialMs: 180, finalMs: 330, totalMs: 2200, partials: 6, emptyFinal: false }], note: "synthetic TTS audio" },
      { provider: "AssemblyAI", language: "Tamil", skipped: "language not supported by this provider (not run, not a result)", runs: [] },
      { provider: "Sarvam", language: "Tamil", skipped: "SARVAM_API_KEY not set", runs: [] },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Provider\s+\| Language\s+\| Runs/);
    expect(text).toContain("250 ms");
    expect(text).toContain("330 ms");
    expect(text).toContain("synthetic TTS audio");
    const tamil = lines.find((l) => l.startsWith("AssemblyAI") && l.includes("Tamil"))!;
    expect(tamil).toContain("skipped: language not supported");
    expect(tamil).not.toMatch(/\d+ ms/);
    expect(lines.find((l) => l.includes("SARVAM_API_KEY"))).toBeTruthy();
  });

  it("with no data at all it prints a table of dashes, not numbers", () => {
    const text = formatReport([{ provider: "X", language: "Y", runs: [{ partials: 0, emptyFinal: false, error: "e" }] }]);
    expect(text).not.toMatch(/\d+ ms/);
    expect(text).toContain("-");
  });
});
