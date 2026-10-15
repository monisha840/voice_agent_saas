#!/usr/bin/env node
// One-command, self-cleaning browser e2e of the account-security UI (see docs/security/ui-verification.md).
//   pnpm --filter @voice-agent/web e2e            # both phases (MFA_ENFORCEMENT=off, then enforce)
//   E2E_PHASES=off pnpm --filter @voice-agent/web e2e
// Env: E2E_ADMIN_URL  owner/superuser connection to a Postgres server that may create databases and roles
//                     (default postgresql://voice_agent:voice_agent@127.0.0.1:5440/postgres; CI: postgres:postgres@localhost:5432)
//      E2E_PHASES     comma list, default "off,enforce"
//      E2E_KEEP_DB    set to keep the throwaway database and role after the run
//      E2E_LOG_DIR    where api-<phase>.log and web.log are written (default: a temp dir)
// All database variables are pinned explicitly because the API scripts also read the repo-root .env
// (DATABASE_MIGRATION_URL there would otherwise redirect migrations to a developer database).
// Creates/drops only database voice_agent_ui_test and role voice_app_uitest. Never touches any other database.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const API = resolve(WEB, "../api");
const DB = "voice_agent_ui_test";
const ROLE = "voice_app_uitest";
const ROLE_PW = "uitest_password_0123456789";
const API_PORT = 4100;
const WEB_PORT = 3100;
const isWin = process.platform === "win32";
const adminUrl = new URL(process.env.E2E_ADMIN_URL ?? "postgresql://voice_agent:voice_agent@127.0.0.1:5440/postgres");
const urlFor = (db, user = adminUrl.username, pw = adminUrl.password) => {
  const u = new URL(adminUrl.toString());
  u.pathname = `/${db}`;
  u.username = user;
  u.password = pw;
  return u.toString();
};
const logDir = process.env.E2E_LOG_DIR ?? mkdtempSync(join(tmpdir(), "va-e2e-logs-"));
mkdirSync(logDir, { recursive: true });
const phases = (process.env.E2E_PHASES ?? "off,enforce").split(",").map((s) => s.trim()).filter(Boolean);

const postgres = createRequire(join(API, "package.json"))("postgres");
const playwrightCli = createRequire(join(WEB, "package.json")).resolve("@playwright/test/cli");
const children = new Set();
let webCopy = null;

function start(cmd, args, opts, logFile) {
  // Straight to the log file, not a pipe: Playwright runs via spawnSync, which blocks this process's event loop, so a
  // pipe would never be drained and a server whose output filled it (~64 KB on Windows) would freeze mid-suite.
  const fd = openSync(join(logDir, logFile), "a");
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", fd, fd], detached: !isWin });
  closeSync(fd);
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function kill(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
async function waitFor(url, what, ms = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${what} did not come up at ${url} within ${ms / 1000}s (logs: ${logDir})`);
}
function run(args, opts) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`node ${args.join(" ")} exited with ${r.status}`);
}
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

async function resetDb() {
  const sql = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await sql.end();
  }
  const adminDb = urlFor(DB);
  run(["--import", "tsx", "src/db/migrate.ts"], { cwd: API, env: { ...process.env, DATABASE_URL: adminDb, DATABASE_MIGRATION_URL: adminDb, PGOPTIONS: "-c client_min_messages=warning" } });
  // voice_app (NOLOGIN runtime role) is created by migration 0012; the throwaway login role joins it.
  const sql2 = postgres(adminDb, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql2`select 1 as x from pg_roles where rolname = ${ROLE}`;
    if (rows.length === 0) await sql2.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' IN ROLE voice_app`);
  } finally {
    await sql2.end();
  }
  run(["--import", "tsx", "src/scripts/ui-e2e-setup.ts"], {
    cwd: API,
    env: { ...process.env, DATABASE_URL: urlFor(DB, ROLE, ROLE_PW), DATABASE_ADMIN_URL: adminDb, DATABASE_MIGRATION_URL: adminDb },
  });
}

async function dropAll() {
  try {
    const sql = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await sql.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    await sql.end();
  } catch (e) {
    console.error("cleanup of database/role failed:", e instanceof Error ? e.message : e);
  }
}

function startApi(phase) {
  const env = {
    ...process.env,
    DATABASE_URL: urlFor(DB, ROLE, ROLE_PW),
    // The API loads the repo-root .env without overriding variables that are already set, so every database
    // variable it knows is pinned here (empty admin URL = no owner connection, like production).
    DATABASE_ADMIN_URL: "",
    DATABASE_MIGRATION_URL: urlFor(DB),
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    MFA_ENFORCEMENT: phase,
    NODE_ENV: "development",
    TELEPHONY_PROVIDER: "mock",
    AI_PROVIDER: "mock",
    PORT_API: String(API_PORT),
    SESSION_COOKIE_NAME: "va_session_uitest",
    WEB_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    PWNED_PASSWORDS: "off",
    HIBP: "off",
  };
  return start(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: API, env }, `api-${phase}.log`);
}

function startWeb() {
  // A COPY of apps/web so a developer's own `next dev` (:3000) and its .next are untouched.
  webCopy = mkdtempSync(join(tmpdir(), "va-e2e-web-"));
  for (const f of ["src", "next.config.mjs", "package.json", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", ".eslintrc.json"]) {
    cpSync(join(WEB, f), join(webCopy, f), { recursive: true });
  }
  symlinkSync(join(WEB, "node_modules"), join(webCopy, "node_modules"), "junction");
  const env = {
    ...process.env,
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
    API_URL: `http://127.0.0.1:${API_PORT}`,
    SESSION_COOKIE_NAME: "va_session_uitest",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const next = join(webCopy, "node_modules/next/dist/bin/next");
  return start(process.execPath, [next, "dev", "-p", String(WEB_PORT), "-H", "127.0.0.1"], { cwd: webCopy, env }, "web.log");
}

let exitCode = 1;
async function main() {
  for (const p of [API_PORT, WEB_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is already in use; stop that process first`);
  }
  const web = startWeb();
  const results = [];
  for (const phase of phases) {
    console.log(`\n=== phase ${phase}: reset ${DB}, start API on :${API_PORT} ===`);
    await resetDb();
    const api = startApi(phase);
    await waitFor(`http://127.0.0.1:${API_PORT}/api/auth/config`, "API");
    await waitFor(`http://127.0.0.1:${WEB_PORT}/login`, "web");
    const r = spawnSync(process.execPath, [playwrightCli, "test"], {
      cwd: WEB,
      stdio: "inherit",
      env: { ...process.env, E2E_PHASE: phase, E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}` },
    });
    results.push([phase, r.status]);
    kill(api);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\nPhase results: " + results.map(([p, s]) => `${p}=${s === 0 ? "PASS" : "FAIL"}`).join(" "));
  exitCode = results.length > 0 && results.every(([, s]) => s === 0) ? 0 : 1;
  kill(web);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  [...children].forEach(kill);
  await new Promise((r) => setTimeout(r, 1000));
  if (webCopy) rmSync(webCopy, { recursive: true, force: true });
  if (!process.env.E2E_KEEP_DB) await dropAll();
  console.log(`logs: ${logDir}`);
}
process.exit(exitCode);
