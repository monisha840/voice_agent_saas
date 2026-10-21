/**
 * Liveness and readiness.
 *
 *  GET /health  liveness: the process is up. Never touches the database (a database blip must not get the process killed).
 *  GET /ready   readiness: this instance can take traffic right now. 503 while shutting down (so the load balancer
 *               drains it) or when a dependency check fails (the database). Reports only pass/fail per check, never
 *               error text.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "../db/client.js";
import { lifecycle } from "./lifecycle.js";

export interface ReadinessCheck {
  name: string;
  /** Resolves when healthy; rejects (or hangs past the timeout) when not. */
  check(): Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

export function databaseCheck(): ReadinessCheck {
  return {
    name: "database",
    check: async () => {
      await sql`select 1`;
    },
  };
}

async function runCheck(c: ReadinessCheck): Promise<"ok" | "fail"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return "ok";
  } catch {
    return "fail";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function healthRoutes(app: FastifyInstance, opts: { checks: ReadinessCheck[] }) {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const draining = lifecycle.isDraining();
    const results = await Promise.all(opts.checks.map(async (c) => [c.name, await runCheck(c)] as const));
    const checks: Record<string, string> = Object.fromEntries(results);
    const ready = !draining && results.every(([, r]) => r === "ok");
    return reply
      .status(ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send({ status: ready ? "ready" : "not_ready", draining, liveCalls: lifecycle.liveCallCount(), checks });
  });
}
