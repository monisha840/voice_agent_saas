import Fastify from "fastify";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { callsRoutes } from "./modules/calls/calls.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { organizationsRoutes } from "./modules/organizations/organizations.routes.js";
import { agentConfigRoutes } from "./modules/agent-config/agent-config.routes.js";
import { agentsRoutes } from "./modules/agents/agents.routes.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { usageRoutes } from "./modules/usage/usage.routes.js";
import { modulesRoutes } from "./modules/modules/modules.routes.js";
import { toolsRoutes } from "./modules/tools/tools.routes.js";
import { CONFIGURED_MODULES } from "./modules.config.js";
import { syncModules } from "./modules/modules/module-runtime.js";
import { registerModuleRoutes } from "./modules/modules/module-routes.js";
import type { ModuleManifest } from "./modules/modules/module-contract.js";
import { webCallRoutes } from "./modules/calls/web-call.routes.js";
import { demoPropertyRoutes } from "./modules/projects/demo-property.routes.js";
import { agentPhoneNumbersRoutes } from "./modules/agents/agent-phone-numbers.routes.js";
import { inboundRoutes } from "./modules/calls/inbound.routes.js";
import { databaseCheck, healthRoutes, type ReadinessCheck } from "./runtime/health.routes.js";
import { resolveRequestId, runWithRequestId } from "./runtime/request-context.js";
import { registerAuth } from "./auth/auth.plugin.js";
import { logger } from "./shared/logger.js";
import { getConfig } from "./config/env.js";
import { globalRateLimitHook, routeRateLimitPluginOptions } from "./security/rate-limits.js";
import { registerSecurityHeaders, registerUniformNotFound } from "./security/http-hardening.js";
import { redactUrl, registerPublicAccessGuard } from "./security/telephony-auth.js";
import {
  ConflictError,
  ForbiddenError,
  LimitExceededError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "./shared/errors.js";

export async function buildApp(
  opts: {
    logStream?: NodeJS.WritableStream;
    /** Which optional modules to plug in (default: the deployment's CONFIGURED_MODULES). `[]` runs the bare Voice AI core. */
    modules?: readonly ModuleManifest[];
    /** What /ready checks (default: the database). Tests substitute failing checks. */
    readinessChecks?: ReadinessCheck[];
  } = {},
) {
  const cfg = getConfig();
  const app = Fastify({
    // Only honor X-Forwarded-* when explicitly told we sit behind a proxy we control.
    // (The public-access guard reads the raw headers itself and is unaffected.)
    trustProxy: cfg.trustProxy,
    // Exotel payloads and dashboard JSON are tiny; refuse anything larger with 413.
    bodyLimit: cfg.bodyLimitBytes,
    // Every request gets an id: a sane incoming X-Request-Id is kept (so a proxy's id carries through), otherwise a
    // fresh UUID. It is echoed in the X-Request-Id response header, stamped on every log line written while serving
    // the request, and included in the body of 5xx errors so a user can quote it.
    requestIdHeader: false,
    genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
    requestIdLogLabel: "requestId",
    logger: {
      stream: opts.logStream,
      // Defense in depth: never serialize credentials even if a header object is logged.
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"],
      // Telephony URLs carry a shared secret in ?token=; never write it to logs.
      serializers: {
        req(req) {
          return { method: req.method, url: redactUrl(req.url ?? ""), hostname: req.hostname };
        },
      },
    },
  });

  // First hook of all: request id header + async context for the structured logger.
  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-request-id", req.id);
    runWithRequestId(req.id, done);
  });

  // Exotel's status-callback can post application/x-www-form-urlencoded.
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: getConfig().realtime.wsMaxPayloadBytes } });
  // Route-level limits (login) use the plugin; the generous per-IP default is our own hook, added
  // BEFORE the login gate so it also counts unauthenticated floods. Exotel/health are exempt. In-memory only.
  await app.register(rateLimit, routeRateLimitPluginOptions());
  app.addHook("onRequest", globalRateLimitHook);
  registerSecurityHeaders(app);
  registerUniformNotFound(app);

  // Public-internet exposure (ngrok etc.): only /health and the Exotel endpoints are served.
  registerPublicAccessGuard(app);
  // CORS (dashboard origin only), cookies, CSRF check, sessions, and the login gate.
  await registerAuth(app);

  // Registered BEFORE the route plugins so every encapsulated route inherits it.
  app.setErrorHandler((err, req, reply) => {
    const status = errorStatus(err);
    if (err instanceof ServiceUnavailableError) {
      logger.warn("service unavailable", { requestId: req.id, error: err.message, method: req.method }); // expected, e.g. while draining
    } else if (status >= 500) {
      // Full detail stays server-side; the client only ever sees a generic message.
      logger.error("unhandled error", { requestId: req.id, error: err.message, stack: err.stack, method: req.method });
    }
    if (err instanceof LimitExceededError && err.retryAfterSeconds) reply.header("retry-after", String(err.retryAfterSeconds));
    // A server that is shutting down says so plainly (its message is safe and useful); other 5xx stay generic.
    const showMessage = status < 500 || err instanceof ServiceUnavailableError;
    const body: Record<string, unknown> = { error: showMessage ? err.message : "Internal server error" };
    if (err instanceof LimitExceededError || err instanceof ServiceUnavailableError) body.code = err.code;
    if (status >= 500) body.requestId = req.id;
    reply.status(status).send(body);
  });

  // Optional modules (Sales, ...) plug in through their manifests: tools, call hooks, prompt templates, permissions,
  // data scopes. Idempotent; this app then serves exactly the modules listed.
  syncModules(opts.modules ?? CONFIGURED_MODULES);

  // /health (liveness) and /ready (readiness: database up and not draining).
  await app.register(healthRoutes, { checks: opts.readinessChecks ?? [databaseCheck()] });

  await app.register(authRoutes);
  await app.register(callsRoutes);
  await app.register(inboundRoutes);
  if (cfg.webCallEnabled) await app.register(webCallRoutes); // temporary browser channel, off unless WEB_CALL_ENABLED=true
  await app.register(demoPropertyRoutes);
  await app.register(usersRoutes);
  await app.register(organizationsRoutes);
  await app.register(modulesRoutes);
  await app.register(agentConfigRoutes);
  await app.register(agentsRoutes);
  await app.register(agentPhoneNumbersRoutes);
  await app.register(auditRoutes);
  await app.register(usageRoutes);
  await app.register(toolsRoutes);

  // Each registered module's routes, behind a gate that refuses organizations that have not enabled the module.
  await registerModuleRoutes(app);

  return app;
}

function errorStatus(err: Error): number {
  if (err instanceof ValidationError) return 400;
  if (err instanceof UnauthorizedError) return 401;
  if (err instanceof ForbiddenError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError) return 409;
  const status = (err as { statusCode?: number }).statusCode;
  return status && status >= 400 && status < 600 ? status : 500;
}
