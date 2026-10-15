/**
 * Plotted projects: the price and configuration tools answer from the client's own plot data, never offer a sold
 * plot, and keep the spoken list short. Also covers the spreadsheet import end to end through the service.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeTool } from "../../../ai-tools/index.js";
import { projectsRepository } from "../../../test/repos.js";
import { callsRepository } from "../../../test/repos.js";
import { systemContext } from "../../../auth/context.js";
import { projectsService } from "../../projects/projects.service.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../../test/tenants.js";
import type { ToolExecutionContext } from "../../../ai-tools/types.js";

let A: TestTenant;
let ctx: ToolExecutionContext;

const plots = Array.from({ length: 14 }, (_, i) => ({
  type: "30x40",
  areaSqft: 1200,
  plotNumber: `A-${String(i + 1).padStart(2, "0")}`,
  facing: i % 2 === 0 ? "East" : "West",
  status: i === 0 ? ("sold" as const) : i === 1 ? ("hold" as const) : ("available" as const),
  pricePerSqft: 2500,
}));

beforeAll(async () => {
  A = await createTenant("PLOT_A");
  const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "outbound", agentId: A.agentId, leadId: A.leadId });
  ctx = { organizationId: A.orgId, subject: { leadId: A.leadId, projectId: A.projectId }, callId: call.id };
  await projectsRepository.upsertKnowledge({ organizationId: A.orgId, projectId: A.projectId, category: "configurations", content: { units: plots } });
});

afterAll(async () => {
  await cleanupTenants();
});

describe("get_project_price for plots", () => {
  it("prices a plot by its number from its rate per square foot", async () => {
    const r = (await executeTool("get_project_price", { configuration: "A-05" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ plotNumber: "A-05", areaSqft: 1200, facing: "East", pricePerSqft: 2500, totalPrice: 3_000_000, currency: "INR" });
  });

  it("does not quote a sold plot", async () => {
    const r = (await executeTool("get_project_price", { configuration: "A-01" }, ctx)) as { error?: string };
    expect(r.error).toContain("sold");
  });

  it("still returns the project's existing price ranges for an apartment type", async () => {
    const r = (await executeTool("get_project_price", { configuration: "2 BHK" }, ctx)) as { min?: number; max?: number };
    expect(r.min).toBe(1);
    expect(r.max).toBe(2);
  });

  it("an unknown plot is an error, not a guess", async () => {
    const r = (await executeTool("get_project_price", { configuration: "Z-99" }, ctx)) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});

describe("get_project_configurations for plots", () => {
  it("lists only plots that can be offered, and no more than ten", async () => {
    const r = (await executeTool("get_project_configurations", {}, ctx)) as { units: Array<{ plotNumber: string; status?: string }>; totalAvailable: number; note?: string };
    expect(r.totalAvailable).toBe(12); // 14 plots, one sold, one on hold
    expect(r.units).toHaveLength(10);
    expect(r.units.every((u) => u.status === "available")).toBe(true);
    expect(r.units.map((u) => u.plotNumber)).not.toContain("A-01");
    expect(r.note).toContain("Showing 10 of 12");
  });

  it("narrows by facing", async () => {
    const r = (await executeTool("get_project_configurations", { facing: "East" }, ctx)) as { units: Array<{ facing: string }>; matchingAvailable: number };
    expect(r.units.every((u) => u.facing === "East")).toBe(true);
    expect(r.matchingAvailable).toBe(6); // East plots are the even indexes 0,2,..,12; index 0 is sold
  });
});

describe("spreadsheet import through the service", () => {
  const owner = () => systemContext(A.orgId, "test");

  it("a dry run shows what would be imported and writes nothing", async () => {
    const before = await projectsRepository.getKnowledge({ organizationId: A.orgId, projectId: A.projectId });
    const r = await projectsService.importKnowledge(owner(), {
      projectId: A.projectId,
      kind: "units",
      csv: "Plot No,Type,Area,Facing,Status,Rate\nP-1,30x40,1200,East,Available,2600\nP-2,30x40,1200,West,Sold,2600\nP-3,30x40,abc,West,Available,2600\n",
      dryRun: true,
    });
    expect(r).toMatchObject({ dryRun: true, accepted: 2, wrote: [] });
    expect(r!.rejected).toHaveLength(1);
    const after = await projectsRepository.getKnowledge({ organizationId: A.orgId, projectId: A.projectId });
    expect(after).toEqual(before);
  });

  it("an import replaces the units and derives price ranges, then the tools answer from it", async () => {
    const r = await projectsService.importKnowledge(owner(), {
      projectId: A.projectId,
      kind: "units",
      csv: "Plot No,Type,Area,Facing,Status,Rate\nP-1,30x40,1200,East,Available,2600\nP-2,30x40,1200,West,Sold,2600\n",
    });
    expect(r).toMatchObject({ accepted: 2, wrote: ["configurations", "pricing"] });
    const price = (await executeTool("get_project_price", { configuration: "P-1" }, ctx)) as { totalPrice?: number };
    expect(price.totalPrice).toBe(3_120_000);
    const list = (await executeTool("get_project_configurations", {}, ctx)) as { totalAvailable: number };
    expect(list.totalAvailable).toBe(1);
  });

  it("an import with no valid rows is refused and changes nothing", async () => {
    await expect(
      projectsService.importKnowledge(owner(), { projectId: A.projectId, kind: "units", csv: "Name,Colour\nA,red\n" }),
    ).rejects.toThrow(/Nothing could be imported/);
  });

  it("a FAQ import writes the questions", async () => {
    const r = await projectsService.importKnowledge(owner(), {
      projectId: A.projectId,
      kind: "faq",
      csv: "Question,Answer\nIs there a clubhouse?,Yes\n",
    });
    expect(r).toMatchObject({ accepted: 1, wrote: ["faq"] });
  });

  it("cannot import into another organization's project", async () => {
    const B = await createTenant("PLOT_B");
    const r = await projectsService.importKnowledge(systemContext(B.orgId, "test"), {
      projectId: A.projectId,
      kind: "faq",
      csv: "Question,Answer\nx,y\n",
    });
    expect(r).toBeNull();
  });
});
