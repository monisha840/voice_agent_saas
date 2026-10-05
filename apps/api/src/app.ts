import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { projectsRoutes } from "./modules/projects/projects.routes.js";
import { leadsRoutes } from "./modules/leads/leads.routes.js";
import { callsRoutes } from "./modules/calls/calls.routes.js";
import { logger } from "./shared/logger.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  // Exotel's status-callback posts application/x-www-form-urlencoded.
  await app.register(formbody);
  await app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(projectsRoutes);
  await app.register(leadsRoutes);
  await app.register(callsRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error("unhandled error", { error: err.message, stack: err.stack });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: status >= 500 ? "Internal server error" : err.message });
  });

  return app;
}
