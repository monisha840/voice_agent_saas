import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

interface Args {
  configuration?: string;
}

interface PlotUnit {
  type: string;
  areaSqft: number;
  plotNumber?: string;
  facing?: string;
  status?: "available" | "sold" | "hold";
  pricePerSqft?: number;
  price?: number;
}

/** A unit's total price: its own stated price, else its rate per square foot times its area. Never invented. */
function priceOf(u: PlotUnit): number | undefined {
  if (u.price !== undefined) return u.price;
  if (u.pricePerSqft !== undefined) return Math.round(u.pricePerSqft * u.areaSqft);
  return undefined;
}

export const getProjectPrice: AiTool<Args> = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_price",
    description:
      "Get approved pricing for a given unit configuration (e.g. '2 BHK', '3 BHK'). Only returns data from approved project knowledge — never invent a price.",
    parameters: {
      type: "object",
      properties: {
        configuration: { type: "string", description: "Unit configuration, e.g. '2 BHK'" },
      },
      required: [],
    },
  },
  async execute(args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_price needs a project on this call" };
    const tctx = toolContext(ctx);
    const [pricing] = await projectsService.getKnowledgeByCategory(tctx, { projectId, category: "pricing" });
    const [configurations] = await projectsService.getKnowledgeByCategory(tctx, { projectId, category: "configurations" });
    const units = ((configurations?.content as { units?: PlotUnit[] } | undefined)?.units ?? []) as PlotUnit[];

    if (!pricing && !units.some((u) => priceOf(u) !== undefined)) return { error: "Pricing information not available" };

    const content = (pricing?.content ?? { currency: "INR", ranges: [] }) as {
      currency: string;
      ranges: Array<{ type: string; min: number; max: number }>;
      perSqft?: { min: number; max: number };
      notes?: string;
    };

    if (args.configuration) {
      const wanted = args.configuration.trim().toLowerCase();
      const match = content.ranges.find((r) => r.type.toLowerCase() === wanted);
      if (match) {
        return { configuration: match.type, min: match.min, max: match.max, currency: content.currency, notes: content.notes };
      }
      // An individual plot or unit, by its number or its type, priced on its own or by its rate per square foot.
      const unit = units.find((u) => u.plotNumber?.toLowerCase() === wanted) ?? units.find((u) => u.type.toLowerCase() === wanted);
      if (unit) {
        if (unit.status === "sold") return { error: `${unit.type} is sold and not available` };
        const total = priceOf(unit);
        if (total !== undefined) {
          return {
            configuration: unit.type,
            ...(unit.plotNumber ? { plotNumber: unit.plotNumber } : {}),
            areaSqft: unit.areaSqft,
            ...(unit.facing ? { facing: unit.facing } : {}),
            ...(unit.status ? { status: unit.status } : {}),
            ...(unit.pricePerSqft ? { pricePerSqft: unit.pricePerSqft } : {}),
            totalPrice: total,
            currency: content.currency,
            notes: content.notes,
          };
        }
      }
      return { error: `No pricing found for configuration "${args.configuration}"` };
    }

    return content;
  },
};
