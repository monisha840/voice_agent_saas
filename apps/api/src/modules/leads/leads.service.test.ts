import { describe, it, expect, beforeAll } from "vitest";
import type { RequestContext } from "../../auth/context.js";
import { demoContext } from "../../test/helpers.js";
import { leadsService } from "./leads.service.js";

describe("leadsService (against seeded DB)", () => {
  let ctx: RequestContext;
  beforeAll(async () => {
    ctx = await demoContext();
  });

  it("listLeads returns the 5 seeded demo leads including Rajesh Kumar", async () => {
    const leads = await leadsService.listLeads(ctx);
    expect(leads.length).toBeGreaterThanOrEqual(5);
    expect(leads.some((l) => l.name === "Rajesh Kumar")).toBe(true);
  });

  it("getLeadDetail returns Rajesh with 2 BHK requirement and callHistory/siteVisits arrays", async () => {
    const leads = await leadsService.listLeads(ctx);
    const rajesh = leads.find((l) => l.name === "Rajesh Kumar")!;

    const detail = await leadsService.getLeadDetail(ctx, { leadId: rajesh.id });
    expect(detail).not.toBeNull();
    expect(detail!.requirementConfig).toBe("2 BHK");
    expect(Array.isArray(detail!.callHistory)).toBe(true);
    expect(Array.isArray(detail!.siteVisits)).toBe(true);
  });

  it("updateLead updates requirementConfig and budget without changing identity fields", async () => {
    const leads = await leadsService.listLeads(ctx);
    const target = leads.find((l) => l.name === "Anil Mehta")!;

    const updated = await leadsService.updateLead(ctx, {
      leadId: target.id,
      requirementConfig: "2 BHK",
      budgetMin: 5500000,
      budgetMax: 6700000,
    });

    expect(updated).not.toBeNull();
    expect(updated!.budgetMin).toBe(5500000);
    expect(updated!.budgetMax).toBe(6700000);
    expect(updated!.name).toBe("Anil Mehta");
  });

  it("getLeadOrThrow throws NotFoundError for a nonexistent lead id", async () => {
    await expect(
      leadsService.getLeadOrThrow(ctx, { leadId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });
});
