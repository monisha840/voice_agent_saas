/**
 * What is near the project, and the other facts a caller asks beyond price and size (approvals, builder, about):
 * the get_nearby_places tool and get_project_details, against the seeded demo project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { followUps } from "../../../db/schema.js";
import { followUpsRepository } from "../../../db/repositories/follow-ups.repository.js";
import { executeTool } from "../../../ai-tools/index.js";
import { projectsService } from "../../projects/projects.service.js";
import { callsService } from "../../calls/calls.service.js";
import { leadsService } from "../../leads/leads.service.js";
import type { ToolExecutionContext } from "../../../ai-tools/types.js";
import type { RequestContext } from "../../../auth/context.js";
import { demoContext } from "../../../test/helpers.js";

describe("get_nearby_places and the wider project facts", () => {
  let ctx: ToolExecutionContext;
  let org: RequestContext;

  beforeAll(async () => {
    org = await demoContext();
    const project = await projectsService.getDefaultProject(org);
    const lead = (await leadsService.listLeads(org)).find((l) => l.name === "Vikram Singh")!;
    const call = await callsService.createCall(org, { leadId: lead.id });
    ctx = { organizationId: org.organizationId, subject: { leadId: lead.id, projectId: project.id }, callId: call.id };
  });

  afterAll(async () => {
    await db.delete(followUps).where(eq(followUps.callId, ctx.callId));
  });

  it("lists the nearest places, nearest first, when no query is given", async () => {
    const r = (await executeTool("get_nearby_places", {}, ctx)) as { places: Array<{ name: string; distanceKm?: number }>; total: number };
    expect(r.total).toBeGreaterThanOrEqual(8);
    const d = r.places.map((p) => p.distanceKm ?? Infinity);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });

  it("finds a kind of place by the words a lead uses", async () => {
    const r = (await executeTool("get_nearby_places", { query: "any hospital nearby" }, ctx)) as { places: Array<{ name: string; type?: string }> };
    expect(r.places.map((p) => p.name)).toContain("Columbia Asia Hospital");
    expect(r.places.every((p) => p.type === "hospital" || /hospital/i.test(p.name))).toBe(true);
  });

  it("finds a named place", async () => {
    const r = (await executeTool("get_nearby_places", { query: "metro" }, ctx)) as { places: Array<{ name: string; travelMinutes?: number }> };
    expect(r.places[0]).toMatchObject({ name: "Whitefield metro station", travelMinutes: 12 });
  });

  it("a place that is not listed is reported as not listed, never invented, with what is known", async () => {
    const r = (await executeTool("get_nearby_places", { query: "Chromepet" }, ctx)) as { places: unknown[]; message: string; listedPlaces: string[] };
    expect(r.places).toEqual([]);
    expect(r.message).toContain("Chromepet");
    expect(r.listedPlaces.length).toBeGreaterThan(0);
  });

  it("a place that is not listed is also noted for the team, so the client can add it (and several are kept on one note)", async () => {
    await executeTool("get_nearby_places", { query: "Brookfield" }, ctx);
    const rows = await followUpsRepository.listByLead({ organizationId: org.organizationId, leadId: ctx.subject!.leadId! });
    const mine = rows.filter((f) => f.callId === ctx.callId && f.kind === "info_requested");
    expect(mine).toHaveLength(1);
    expect(mine[0].note).toContain("Chromepet");
    expect(mine[0].note).toContain("Brookfield");
  });

  it("get_project_details carries approvals, builder and about, and points at the nearby lookup", async () => {
    const r = (await executeTool("get_project_details", {}, ctx)) as Record<string, unknown>;
    expect(r.approvals).toBeDefined();
    expect(r.builder).toMatchObject({ name: "Green Valley Developers" });
    expect(r.about).toMatchObject({ text: expect.stringContaining("Whitefield") });
    expect(String(r.nearbyPlacesAvailable)).toContain("get_nearby_places");
    expect(r).not.toHaveProperty("nearby"); // the long list is looked up, not dumped into every answer
  });

  it("needs a project on the call", async () => {
    const r = await executeTool("get_nearby_places", {}, { organizationId: org.organizationId, callId: ctx.callId });
    expect(r).toMatchObject({ error: expect.any(String) });
  });
});
