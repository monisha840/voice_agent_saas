/**
 * Sales part of the dashboard overview: lead totals and outcomes, leads per day, the newest leads and the next
 * upcoming site visits. Everything comes from the scoped services (organization from the session, lead scope by
 * role); sections the caller's role cannot read are returned as null rather than refused.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { can } from "../../auth/access.js";
import { parseInput } from "../../shared/validation.js";
import { dashboardTimeZone, fillDays, startOfDayWindow } from "../../shared/day-series.js";
import { leadsService } from "../leads/leads.service.js";
import { siteVisitsService } from "../site-visits/site-visits.service.js";

const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

/** The same outcome groups the leads list has always used (no new business definition). */
const INTERESTED = ["INTERESTED", "VISIT_BOOKED", "CONFIRMED", "VISITED"];
const VISIT_STAGE = ["VISIT_BOOKED", "CONFIRMED", "VISITED"];

export async function salesOverviewRoutes(app: FastifyInstance) {
  app.get("/api/sales/overview", async (req, reply) => {
    const ctx = requireContext(req);
    const { days } = parseInput(query, req.query);
    const timeZone = dashboardTimeZone();
    const from = startOfDayWindow(new Date(), days, timeZone);

    const [leadStats, recentLeads, upcoming] = await Promise.all([
      can(ctx, "leads:read") ? leadsService.leadStats(ctx, { from, timeZone }) : null,
      can(ctx, "leads:read") ? leadsService.listLeadsPage(ctx, { limit: 5, offset: 0 }) : null,
      can(ctx, "site-visits:read") ? siteVisitsService.listPage(ctx, { view: "upcoming", limit: 5, offset: 0 }) : null,
    ]);

    const byStatus = Object.fromEntries((leadStats?.byStatus ?? []).map((r) => [r.status, r.n]));
    const sum = (keys: string[]) => keys.reduce((n, k) => n + (byStatus[k] ?? 0), 0);
    const daily = leadStats ? fillDays(leadStats.daily, from, days, timeZone, { total: 0 }) : null;

    return reply.send({
      data: {
        days,
        from: from.toISOString(),
        timeZone,
        leads: leadStats
          ? {
              total: Object.values(byStatus).reduce((a, b) => a + b, 0),
              newInWindow: daily!.reduce((n, d) => n + d.total, 0),
              interested: sum(INTERESTED),
              visitStage: sum(VISIT_STAGE),
              byStatus,
              daily,
            }
          : null,
        recentLeads: recentLeads?.data ?? null,
        upcomingVisits: upcoming ? { total: upcoming.total, data: upcoming.data } : null,
      },
    });
  });
}
