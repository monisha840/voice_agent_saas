/**
 * The HTTP routes the Sales module contributes. The core registers them through the module runtime, inside a scope
 * that refuses users of organizations that have not enabled Sales, so a route here can never be reached without the
 * module (and a route cannot forget to check).
 */
import type { FastifyInstance } from "fastify";
import { leadsRoutes } from "../leads/leads.routes.js";
import { projectsRoutes } from "../projects/projects.routes.js";
import { siteVisitsRoutes } from "../site-visits/site-visits.routes.js";
import { followUpsRoutes } from "../follow-ups/follow-ups.routes.js";
import { salesOverviewRoutes } from "./sales-overview.routes.js";

export const salesRoutes: ReadonlyArray<(app: FastifyInstance) => Promise<void>> = [projectsRoutes, leadsRoutes, siteVisitsRoutes, followUpsRoutes, salesOverviewRoutes];
