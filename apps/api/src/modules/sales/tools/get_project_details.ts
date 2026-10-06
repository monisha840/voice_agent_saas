import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";

export const getProjectDetails: AiTool = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_project_details",
    description:
      "Get general details about the real-estate project: name, location, amenities, possession date, and frequently asked questions (RERA status, loan assistance, booking amount, maintenance charges). Use this for general questions not covered by a more specific tool.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_project_details needs a project on this call" };
    const project = await projectsService.getProjectWithKnowledge(toolContext(ctx), { projectId });
    if (!project) return { error: "Project not found" };

    const amenities = project.knowledge.find((k) => k.category === "amenities")?.content;
    const possession = project.knowledge.find((k) => k.category === "possession")?.content;
    const location = project.knowledge.find((k) => k.category === "location")?.content;
    const faq = project.knowledge.find((k) => k.category === "faq")?.content;

    // Structured facts added with project management; undefined (omitted) when not set.
    const rera = project.knowledge.find((k) => k.category === "rera")?.content;
    const loan = project.knowledge.find((k) => k.category === "loan")?.content;
    const booking = project.knowledge.find((k) => k.category === "booking")?.content;
    const maintenance = project.knowledge.find((k) => k.category === "maintenance")?.content;

    return {
      name: project.name,
      location: project.location,
      amenities,
      possession,
      locationDetails: location,
      faq,
      rera,
      loan,
      booking,
      maintenance,
    };
  },
};
