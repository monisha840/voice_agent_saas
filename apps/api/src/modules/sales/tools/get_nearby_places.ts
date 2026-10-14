import type { AiTool } from "../../../ai-tools/types.js";
import { salesSubject } from "./sales-subject.js";
import { toolContext } from "../../../ai-tools/tool-context.js";
import { projectsService } from "../../projects/projects.service.js";
import { followUpsService } from "../../follow-ups/follow-ups.service.js";

interface Args {
  query?: string;
}

interface Place {
  name: string;
  type?: string;
  distanceKm?: number;
  travelMinutes?: number;
  notes?: string;
}

const MAX_RESULTS = 8;
const MAX_LISTED = 15;

/** Words a lead uses for a kind of place, mapped to the stored type ("hospital", "school", ...). */
const TYPE_WORDS: Record<string, string[]> = {
  school: ["school", "schools"],
  college: ["college", "university"],
  hospital: ["hospital", "clinic", "doctor", "medical"],
  it_park: ["it", "park", "tech", "itpl", "software"],
  office: ["office", "work"],
  mall: ["mall", "shopping", "supermarket"],
  market: ["market", "bazaar"],
  metro: ["metro"],
  railway: ["railway", "train", "station"],
  bus: ["bus", "busstand"],
  airport: ["airport", "flight"],
  highway: ["highway", "road", "orr", "nh"],
  temple: ["temple", "church", "mosque"],
};

/** The places of this project that match what the lead asked about. Nothing outside the project's own data is returned. */
export const getNearbyPlaces: AiTool<Args> = {
  module: "sales",
  requires: ["project"],
  definition: {
    name: "get_nearby_places",
    description:
      "Look up what is near the project (schools, hospitals, offices, metro or railway, malls, highways, landmarks) with distance and travel time. Pass the place or kind of place the lead asked about as query (for example 'hospital', 'Chromepet', 'metro'); leave it out to list the nearest places. Only places in the project's data are returned: if none matches, say you do not have that place.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The place or kind of place the lead asked about" } },
      required: [],
    },
  },
  async execute(args, ctx) {
    const projectId = salesSubject(ctx).projectId;
    if (!projectId) return { error: "get_nearby_places needs a project on this call" };
    const [row] = await projectsService.getKnowledgeByCategory(toolContext(ctx), { projectId, category: "nearby" });
    const items = ((row?.content as { items?: Place[] } | undefined)?.items ?? []).filter((p) => p && typeof p.name === "string");
    if (items.length === 0) return { error: "No nearby-places information is available for this project" };

    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const byDistance = (a: Place, b: Place) => (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER);
    if (!query) return { places: [...items].sort(byDistance).slice(0, MAX_RESULTS), total: items.length };

    const tokens = query.split(/\s+/).filter((t) => t.length > 1);
    const typesAsked = Object.entries(TYPE_WORDS)
      .filter(([, words]) => tokens.some((t) => words.includes(t)))
      .map(([type]) => type);
    const matches = items.filter((p) => {
      const hay = `${p.name} ${p.notes ?? ""}`.toLowerCase();
      return (p.type !== undefined && typesAsked.includes(p.type)) || tokens.some((t) => hay.includes(t));
    });
    if (matches.length > 0) return { places: matches.sort(byDistance).slice(0, MAX_RESULTS), total: matches.length };
    // Nothing matched: the team is told what was asked (the client can add it to the project), and the agent is shown
    // what IS known so it can offer that instead of guessing.
    try {
      await followUpsService.record(toolContext(ctx), {
        leadId: salesSubject(ctx).leadId ?? null,
        callId: ctx.callId,
        kind: "info_requested",
        note: `Asked about "${String(args.query).slice(0, 80)}": not in the project's nearby places`,
      });
    } catch {
      // a note for the team must never break the answer
    }
    return {
      places: [],
      message: `No place matching "${args.query}" is listed for this project.`,
      listedPlaces: items.slice(0, MAX_LISTED).map((p) => p.name),
    };
  },
};
