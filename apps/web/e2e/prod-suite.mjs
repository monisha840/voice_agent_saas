// Shared harness for the self-cleaning browser e2e suites that run against a PRODUCTION web build
// (billing-run.mjs, dashboard-run.mjs). Each suite passes its OWN database, runtime role, ports, cookie name, seed
// script and Playwright config, so suites never share a database, port or .next directory. Never touches any other
// database. Env: E2E_ADMIN_URL (owner/superuser URL, default postgresql://voice_agent:voice_agent@127.0.0.1:5440/postgres),
// E2E_KEEP_DB, E2E_LOG_DIR, E2E_GREP.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const API = resolve(WEB, "../api");
const isWin = process.platform === "win32";

/**
 * @param {{ name: string, db: string, role: string, rolePassword: string, apiPort: number, webPort: number,
 *           cookieName: string, seedScript: string, config: string }} suite
 */
export async function runProdSuite(suite) {
  const { db: DB, role: ROLE, rolePassword: ROLE_PW, apiPort: API_PORT, webPort: WEB_PORT } = suite;
  const adminUrl = new URL(process.env.E2E_ADMIN_URL ?? "postgresql://voice_agent:voice_agent@127.0.0.1:5440/postgres");
  const urlFor = (db, user = adminUrl.username, pw = adminUrl.password) => {
    const u = new URL(adminUrl.toString());
    u.pathname = `/${db}`;
    u.username = user;
    u.password = pw;
    return u.toString();
  };
  const logDir = process.env.E2E_LOG_DIR ?? mkdtempSync(join(tmpdir(), `va-${suite.name}e2e-logs-`));
  mkdirSync(logDir, { recursive: true });

  const postgres = createRequire(join(API, "package.json"))("postgres");
  const playwrightCli = createRequire(join(WEB, "package.json")).resolve("@playwright/test/cli");
  const children = new Set();
  let webCopy = null;

  function start(cmd, args, opts, logFile) {
    // The child writes straight to the log file. Not a pipe: Playwright runs below via spawnSync, which blocks this
    // process's event loop, so nothing would drain a pipe; on Windows pipe writes are synchronous and a server whose
    // output filled the pipe buffer (~64 KB) would freeze mid-suite (and the log would stop after the first lines).
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
    const sql2 = postgres(adminDb, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql2`select 1 as x from pg_roles where rolname = ${ROLE}`;
      if (rows.length === 0) await sql2.unsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' IN ROLE voice_app`);
    } finally {
      await sql2.end();
    }
    run(["--import", "tsx", suite.seedScript], {
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

  function startApi() {
    const env = {
      ...process.env,
      DATABASE_URL: urlFor(DB, ROLE, ROLE_PW),
      DATABASE_ADMIN_URL: "", // no owner connection, like production
      DATABASE_MIGRATION_URL: urlFor(DB),
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MFA_ENFORCEMENT: "off",
      NODE_ENV: "development",
      TELEPHONY_PROVIDER: "mock",
      AI_PROVIDER: "mock",
      PORT_API: String(API_PORT),
      SESSION_COOKIE_NAME: suite.cookieName,
      WEB_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      // One machine drives every user (and the Next server proxies all SSR calls from one IP): lift the per-IP cap so the
      // suite measures the product, not the global limiter.
      RATE_LIMIT_API_MAX: "100000",
      RATE_LIMIT_USER_MAX: "100000",
      RATE_LIMIT_ORG_MAX: "100000",
      PWNED_PASSWORDS: "off",
      HIBP: "off",
    };
    return start(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: API, env }, "api.log");
  }

  /** Production build of a COPY of apps/web (the developer's .next is untouched), then `next start`. */
  function buildAndStartWeb() {
    webCopy = mkdtempSync(join(tmpdir(), `va-${suite.name}e2e-web-`));
    for (const f of ["src", "next.config.mjs", "package.json", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", ".eslintrc.json"]) {
      cpSync(join(WEB, f), join(webCopy, f), { recursive: true });
    }
    symlinkSync(join(WEB, "node_modules"), join(webCopy, "node_modules"), "junction");
    const env = {
      ...process.env,
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
      API_URL: `http://127.0.0.1:${API_PORT}`,
      SESSION_COOKIE_NAME: suite.cookieName,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const next = join(webCopy, "node_modules/next/dist/bin/next");
    console.log("building production web bundle (next build) ...");
    const b = spawnSync(process.execPath, [next, "build"], { cwd: webCopy, env, stdio: "inherit" });
    if (b.status !== 0) throw new Error(`next build failed (${b.status})`);
    return start(process.execPath, [next, "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"], { cwd: webCopy, env }, "web.log");
  }

  let exitCode = 1;
  try {
    for (const p of [API_PORT, WEB_PORT]) {
      if (!(await portFree(p))) throw new Error(`port ${p} is already in use; stop that process first`);
    }
    await resetDb();
    const api = startApi();
    await waitFor(`http://127.0.0.1:${API_PORT}/api/auth/config`, "API");
    const web = buildAndStartWeb();
    await waitFor(`http://127.0.0.1:${WEB_PORT}/login`, "web");
    const r = spawnSync(process.execPath, [playwrightCli, "test", "--config", suite.config, ...(process.env.E2E_GREP ? ["--grep", process.env.E2E_GREP] : [])], {
      cwd: WEB,
      stdio: "inherit",
      env: { ...process.env, E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}`, E2E_API_URL: `http://127.0.0.1:${API_PORT}` },
    });
    exitCode = r.status === 0 ? 0 : 1;
    kill(api);
    kill(web);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  } finally {
    [...children].forEach(kill);
    await new Promise((r) => setTimeout(r, 1000));
    if (webCopy) rmSync(webCopy, { recursive: true, force: true });
    if (!process.env.E2E_KEEP_DB) await dropAll();
    console.log(`logs: ${logDir}`);
  }
  return exitCode;
}
