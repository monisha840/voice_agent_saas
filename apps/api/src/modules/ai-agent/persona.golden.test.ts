/**
 * GOLDEN TEST: the legacy real-estate sales prompt must stay byte-identical.
 *
 * The agent-first refactor moves persona ownership onto agents, but every agent migrated from
 * today's configuration (template "sales_real_estate") must produce EXACTLY the system prompt the
 * product produces today. The expected strings live in persona.golden.json, captured from the
 * pre-refactor code. Do not regenerate the file to make a failing test pass: a diff here means
 * existing sales calls would behave differently.
 *
 * (Regenerate only for an intentional, reviewed prompt change: GOLDEN_WRITE=1 pnpm test persona.golden)
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "./persona.js";
import { DEFAULT_AGENT_CONFIG } from "../agent-config/agent-config.service.js";
import { getToolDefinitions } from "../../ai-tools/index.js";
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "persona.golden.json");
const params = { leadName: "Rajesh Kumar", projectName: "Green Valley Residency" };

const FULL_CONFIG: ResolvedAgentConfig = {
  agentName: "Asha",
  companyName: "Blue Sky Homes",
  greeting: "Namaste from Blue Sky",
  disclosureText: "I am a virtual assistant",
  language: "hi-IN",
  tone: "energetic",
  callObjective: "Book weekend visits",
  qualificationQuestions: ["When do you plan to buy?", "Do you need a home loan?"],
  callBehaviour: { maxResponseSentences: 2, endCallWhenDone: false },
  allowedTools: ["get_project_details", "check_visit_slots", "book_site_visit"],
  siteVisitBehaviour: { offerSlots: 1, autoBook: false },
  extraInstructions: "Mention the free parking offer.",
};

/** Every prompt shape the product can produce today. */
function currentOutputs(): Record<string, string | string[]> {
  return {
    noConfig: buildSystemPrompt(params),
    nullConfig: buildSystemPrompt(params, null),
    builtInDefaultConfig: buildSystemPrompt(params, { ...DEFAULT_AGENT_CONFIG }),
    defaultConfigOtherLead: buildSystemPrompt({ leadName: "Sunita Rao", projectName: "Lake View" }, { ...DEFAULT_AGENT_CONFIG }),
    fullConfig: buildSystemPrompt(params, FULL_CONFIG),
    toneFormalEnglishCustomName: buildSystemPrompt(params, {
      ...DEFAULT_AGENT_CONFIG,
      agentName: "Priya Nair",
      tone: "formal",
    }),
    toolNamesAllTools: getToolDefinitions().map((t) => t.name),
    toolNamesRestricted: getToolDefinitions(["get_project_price"]).map((t) => t.name),
  };
}

describe("legacy sales prompt (golden)", () => {
  if (process.env.GOLDEN_WRITE === "1" || !existsSync(GOLDEN_PATH)) {
    it("writes the golden file (GOLDEN_WRITE=1 or first run)", () => {
      writeFileSync(GOLDEN_PATH, JSON.stringify(currentOutputs(), null, 2) + "\n", "utf8");
    });
    return;
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string | string[]>;
  const actual = currentOutputs();

  it("covers every expected case", () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(actual).sort());
  });

  for (const key of Object.keys(golden)) {
    it(`is byte-identical: ${key}`, () => {
      expect(actual[key]).toEqual(golden[key]);
    });
  }
});
