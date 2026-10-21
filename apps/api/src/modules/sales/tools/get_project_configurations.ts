import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

export const getProjectConfigurations: AiTool = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_configurations",
    description:
      "Get the available unit configurations (e.g. 2 BHK, 3 BHK, or plots) and their sizes. For plotted projects, only plots that can be offered are listed; pass facing or type to narrow the list.",
    parameters: {
      type: "object",
      properties: {
        facing: { type: "string", description: "Only plots with this facing, e.g. 'East'" },
        type: { type: "string", description: "Only units of this type or size, e.g. '30x40'" },
      },
      required: [],
    },
  },
  async execute(args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_configurations needs a project on this call" };
    const [configurations] = await projectsService.getKnowledgeByCategory(toolContext(ctx), {
      projectId,
      category: "configurations",
    });

    if (!configurations) return { error: "Configuration information not available" };

    const content = configurations.content as { units?: Array<Record<string, unknown>> };
    const units = content.units ?? [];
    // Plain apartment types: unchanged.
    if (!units.some((u) => u.status !== undefined || u.plotNumber !== undefined)) return configurations.content;

    // Plotted project: never offer a sold or held plot, and keep the list short enough to speak.
    const wantFacing = (args as { facing?: string }).facing?.trim().toLowerCase();
    const wantType = (args as { type?: string }).type?.trim().toLowerCase();
    const offerable = units.filter((u) => (u.status ?? "available") === "available");
    const matching = offerable.filter(
      (u) =>
        (!wantFacing || String(u.facing ?? "").toLowerCase() === wantFacing) &&
        (!wantType || String(u.type ?? "").toLowerCase() === wantType),
    );
    const LIMIT = 10;
    return {
      units: matching.slice(0, LIMIT),
      matchingAvailable: matching.length,
      totalAvailable: offerable.length,
      ...(matching.length > LIMIT ? { note: `Showing ${LIMIT} of ${matching.length}. Ask the caller for a facing or size to narrow the list.` } : {}),
    };
  },
};
