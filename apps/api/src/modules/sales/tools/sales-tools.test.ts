import { describe, it, expect, beforeAll } from "vitest";
import { executeTool, getToolDefinitions } from "../../../ai-tools/index.js";
import { projectsService } from "../../projects/projects.service.js";
import { leadsService } from "../../leads/leads.service.js";
import { callsService } from "../../calls/calls.service.js";
import type { ToolExecutionContext } from "../../../ai-tools/types.js";
import type { RequestContext } from "../../../auth/context.js";
import { demoContext } from "../../../test/helpers.js";

describe("AI tools (executed against seeded DB, exercising the real service layer)", () => {
  let ctx: ToolExecutionContext;
  let org: RequestContext;

  beforeAll(async () => {
    org = await demoContext();
    const project = await projectsService.getDefaultProject(org);
    const leads = await leadsService.listLeads(org);
    const lead = leads.find((l) => l.name === "Vikram Singh")!; // avoid clashing with other tests' target leads
    const call = await callsService.createCall(org, { leadId: lead.id });

    ctx = { organizationId: org.organizationId, subject: { leadId: lead.id, projectId: project.id }, callId: call.id };
  });

  it("exposes exactly the 9 expected tool definitions", () => {
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toEqual([
      "get_project_details",
      "get_project_price",
      "get_project_configurations",
      "get_project_location",
      "check_visit_slots",
      "book_site_visit",
      "update_lead",
      "mark_not_interested",
      "end_call",
    ]);
  });

  it("get_project_price returns the approved 2 BHK price range, not an invented value", async () => {
    const result = (await executeTool("get_project_price", { configuration: "2 BHK" }, ctx)) as {
      min: number;
      max: number;
      currency: string;
    };
    expect(result.min).toBe(6500000);
    expect(result.max).toBe(7800000);
    expect(result.currency).toBe("INR");
  });

  it("get_project_price returns an error (not a guess) for an unknown configuration", async () => {
    const result = (await executeTool("get_project_price", { configuration: "4 BHK" }, ctx)) as {
      error?: string;
    };
    expect(result.error).toBeTruthy();
  });

  it("get_project_configurations returns both seeded unit types", async () => {
    const result = (await executeTool("get_project_configurations", {}, ctx)) as {
      units: Array<{ type: string }>;
    };
    expect(result.units.map((u) => u.type)).toEqual(expect.arrayContaining(["2 BHK", "3 BHK"]));
  });

  it("check_visit_slots returns structured slot data", async () => {
    const result = (await executeTool("check_visit_slots", {}, ctx)) as {
      slots: Array<{ id: string; isoDateTime: string }>;
    };
    expect(result.slots.length).toBe(3);
  });

  it("book_site_visit creates a visit and moves the lead to VISIT_BOOKED", async () => {
    const slots = (await executeTool("check_visit_slots", {}, ctx)) as {
      slots: Array<{ isoDateTime: string }>;
    };
    const chosen = slots.slots[0];

    const result = (await executeTool("book_site_visit", { isoDateTime: chosen.isoDateTime }, ctx)) as {
      booked: boolean;
      scheduledAt: string;
    };
    expect(result.booked).toBe(true);

    const lead = await leadsService.getLeadDetail(org, { leadId: ctx.subject!.leadId });
    expect(lead!.status).toBe("VISIT_BOOKED");
    expect(lead!.siteVisits.length).toBeGreaterThan(0);
  });

  it("update_lead persists requirement/budget via the service layer (never raw SQL)", async () => {
    const result = (await executeTool(
      "update_lead",
      { requirementConfig: "2 BHK", budgetMin: 6000000, budgetMax: 7500000 },
      ctx,
    )) as { updated: boolean };
    expect(result.updated).toBe(true);

    const lead = await leadsService.getLeadDetail(org, { leadId: ctx.subject!.leadId });
    expect(lead!.requirementConfig).toBe("2 BHK");
  });

  it("mark_not_interested sets lead status to NOT_INTERESTED", async () => {
    const result = (await executeTool("mark_not_interested", {}, ctx)) as { marked: boolean };
    expect(result.marked).toBe(true);

    const lead = await leadsService.getLeadDetail(org, { leadId: ctx.subject!.leadId });
    expect(lead!.status).toBe("NOT_INTERESTED");
  });

  it("an unknown tool name returns a structured error instead of throwing", async () => {
    const result = (await executeTool("not_a_real_tool", {}, ctx)) as { error?: string };
    expect(result.error).toContain("Unknown tool");
  });
});
