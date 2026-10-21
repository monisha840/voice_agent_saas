#!/usr/bin/env node
/**
 * Fails a test run that LOOKS green but did not actually run everything.
 *
 * Why this exists: on 2026-10-21 a full local run reported "156 passed | 4 skipped (161) / 2077 passed | 13 skipped
 * (2127)" and exited 0. Those numbers do not add up -- one test FILE and 37 TESTS never reported at all, because a
 * forked worker died mid-file ("[vitest-pool]: Worker forks emitted error -> Worker exited unexpectedly"). Vitest
 * exits 0 in that case, so a required CI check would have gone green while silently skipping tests. That is worse
 * than a red check, and it is invisible unless something reconciles the counts.
 *
 * Reads vitest's JSON report (machine-readable, not scraped console text) and refuses a run unless:
 *   - every test file on disk reported a result,
 *   - the test tallies add up to the collected total,
 *   - at least --min-files files were found (catches a broken include glob that matches almost nothing),
 *   - no test failed.
 *
 * NOTE on the report's shape, verified against vitest 4.1.11 output rather than assumed:
 *   - `testResults` is one entry per test FILE (161 here).
 *   - `numTotalTestSuites` counts `describe` BLOCKS (649 here), NOT files. Do not compare it with a file count --
 *     an earlier version of this script did and failed every healthy run.
 *   - `numTotalTests` is the COLLECTED total, which is why it still exceeds the reported tallies when a worker dies.
 *     That difference is the reliable detector.
 *
 * Usage:  node scripts/verify-test-run.mjs <report.json> [--min-files=N] [--package-dir=.]
 *
 * Exit 0 only when the run is complete and fully passing. Anything else exits 1 with the reason, so a genuine test
 * failure is still a failure here -- this guard never converts a red run into a green one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [, , reportPath, ...rest] = process.argv;
if (!reportPath) {
  console.error("verify-test-run: usage: node scripts/verify-test-run.mjs <report.json> [--min-files=N] [--package-dir=.]");
  process.exit(1);
}
const arg = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const minFiles = Number(arg("min-files", "0"));
const packageDir = resolve(arg("package-dir", "."));

/** A missing or unparseable report is itself a failure: it usually means the run died before writing one. */
let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`verify-test-run: FAIL - could not read the JSON report at ${reportPath}`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error("  A run that produced no report did not finish. Treat this as an incomplete run, not a pass.");
  process.exit(1);
}

/** Test files on disk, matching vitest.config.ts's include ("src/**\/*.test.ts"). The source of truth for "discovered". */
function discoverTestFiles() {
  try {
    return readdirSync(resolve(packageDir, "src"), { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".test.ts"))
      .map((p) => p.replace(/\\/g, "/"));
  } catch {
    return null; // cannot enumerate (wrong --package-dir): fall back to the tally checks only
  }
}

const n = (key) => (typeof report[key] === "number" ? report[key] : 0);
const reportedFiles = Array.isArray(report.testResults) ? report.testResults.length : 0;
const discovered = discoverTestFiles();

const totalTests = n("numTotalTests");
const testTally = n("numPassedTests") + n("numFailedTests") + n("numPendingTests") + n("numTodoTests");

const problems = [];

if (minFiles > 0 && reportedFiles < minFiles) {
  problems.push(`only ${reportedFiles} test files reported, expected at least ${minFiles} (broken include glob, or the run died early?)`);
}

if (discovered === null) {
  console.warn(`verify-test-run: WARN - could not enumerate test files under ${packageDir}/src; checking tallies only`);
} else if (reportedFiles !== discovered.length) {
  problems.push(`${reportedFiles} of ${discovered.length} test files on disk reported a result - ${discovered.length - reportedFiles} never reported (worker crash?)`);
  const ran = new Set(
    (report.testResults ?? []).map((r) => String(r.name ?? "").replace(/\\/g, "/")),
  );
  const missing = discovered.filter((f) => ![...ran].some((r) => r.endsWith(f)));
  for (const f of missing.slice(0, 20)) problems.push(`  never reported: src/${f}`);
}

if (testTally !== totalTests) {
  problems.push(
    `test tallies do not reconcile: passed ${n("numPassedTests")} + failed ${n("numFailedTests")} + skipped ${n("numPendingTests")} + todo ${n("numTodoTests")} = ${testTally}, but ${totalTests} were collected - ${totalTests - testTally} tests never ran`,
  );
}

if (n("numFailedTests") > 0 || n("numFailedTestSuites") > 0) {
  problems.push(`${n("numFailedTests")} test(s) failed across ${n("numFailedTestSuites")} suite(s)`);
}

const summary = `files ${reportedFiles}${discovered ? `/${discovered.length}` : ""} reported | tests ${testTally}/${totalTests} accounted (${n("numPassedTests")} passed, ${n("numFailedTests")} failed, ${n("numPendingTests")} skipped, ${n("numTodoTests")} todo)`;

if (problems.length > 0) {
  console.error(`verify-test-run: FAIL - ${summary}`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  console.error("  An exit code of 0 from vitest does NOT mean every test ran. If files or tests are unaccounted for,");
  console.error("  a worker exited early and its tests were silently dropped - re-running is not a fix, diagnose it.");
  process.exit(1);
}

console.log(`verify-test-run: OK - ${summary}`);
