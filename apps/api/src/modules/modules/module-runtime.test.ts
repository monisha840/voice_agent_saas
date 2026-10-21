/**
 * The core with and without a module plugged in. No database: this is about what the registries do.
 * The Sales module is registered by the test setup; each test that unplugs it plugs it back afterwards.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ALL_TOOL_NAMES, executeTool, getToolCatalog, getToolDefinitions, registerTool } from "../../ai-tools/index.js";
import { resolveEffectiveTools } from "../../ai-tools/effective-tools.js";
import { buildSystemPrompt } from "../ai-agent/persona.js";
import { generateCallSummary, isGenericSummary } from "../ai-agent/post-call-summary.js";
import { MockLlmProvider } from "../../adapters/ai/mock.llm.provider.js";
import { registerSalesModule } from "../sales/index.js";
import { isModuleRegistered, registerModule, registeredModuleKeys, unregisterModule } from "./module-runtime.js";
import type { ModuleManifest } from "./module-contract.js";

const SALES_TOOLS = [
  "get_project_details",
  "get_project_price",
  "get_project_configurations",
  "get_project_location",
  "check_visit_slots",
  "book_site_visit",
  "update_lead",
  "mark_not_interested",
];
const FULL_CONTEXT = { lead: true, project: true };
const TRANSCRIPT = [
  { speaker: "ai" as const, text: "Hello", timestamp: "2030-01-01T00:00:00Z" },
  { speaker: "lead" as const, text: "Hi", timestamp: "2030-01-01T00:00:01Z" },
];

afterEach(() => {
  unregisterModule("fake");
  registerSalesModule();
});

const fakeModule: ModuleManifest = {
  key: "fake",
  tools: [
    {
      module: "fake",
      requires: ["patient"],
      definition: { name: "fake_lookup", description: "x", parameters: { type: "object", properties: {}, required: [] } },
      async execute() {
        return { ok: true };
      },
    },
  ],
  promptTemplates: [{ key: "fake_template", build: () => "FAKE PROMPT", summaryProfile: "fake_profile" }],
  summaryProfiles: [{ key: "fake_profile", generate: async () => ({ kind: "fake" }) }],
};

describe("module registration", () => {
  it("a module's tools, prompt template and summary profile appear on register and vanish on unregister", async () => {
    registerModule(fakeModule);
    expect(isModuleRegistered("fake")).toBe(true);
    expect(getToolCatalog().find((t) => t.name === "fake_lookup")).toMatchObject({ module: "fake", requires: ["patient"] });
    expect(buildSystemPrompt({}, { promptTemplateKey: "fake_template" as never })).toBe("FAKE PROMPT");
    expect(await generateCallSummary(new MockLlmProvider(), TRANSCRIPT, "fake_profile")).toEqual({ kind: "fake" });

    unregisterModule("fake");
    expect(isModuleRegistered("fake")).toBe(false);
    expect(ALL_TOOL_NAMES).not.toContain("fake_lookup");
    expect(await executeTool("fake_lookup", {}, { organizationId: "o", callId: "c" }, ["fake_lookup"])).toEqual({ error: "Unknown tool: fake_lookup" });
    expect(buildSystemPrompt({}, { promptTemplateKey: "fake_template" as never })).not.toBe("FAKE PROMPT");
    expect(isGenericSummary(await generateCallSummary(new MockLlmProvider(), TRANSCRIPT, "fake_profile"))).toBe(true);
  });

  it("registering twice replaces rather than duplicates", () => {
    registerModule(fakeModule);
    registerModule(fakeModule);
    expect(ALL_TOOL_NAMES.filter((n) => n === "fake_lookup")).toHaveLength(1);
    expect(registeredModuleKeys().filter((k) => k === "fake")).toHaveLength(1);
  });

  it("end_call belongs to the core: no module can replace or remove it", () => {
    expect(() =>
      registerTool({ definition: { name: "end_call", description: "evil", parameters: { type: "object", properties: {} } }, execute: async () => ({}) }),
    ).toThrow(/reserved/);
    unregisterModule("sales");
    expect(ALL_TOOL_NAMES).toEqual(["end_call"]);
  });

  it("a module tool needs its module enabled AND its required context", () => {
    registerModule(fakeModule);
    const input = { enabledTools: ["fake_lookup"], enabledModules: ["fake"], context: { patient: true } };
    expect(resolveEffectiveTools(input)).toEqual(["fake_lookup", "end_call"]);
    expect(resolveEffectiveTools({ ...input, enabledModules: [] })).toEqual(["end_call"]);
    expect(resolveEffectiveTools({ ...input, context: {} })).toEqual(["end_call"]);
  });
});

describe("the core with the Sales module NOT registered", () => {
  it("cannot expose Sales tools, whatever the agent, modules or context say", () => {
    unregisterModule("sales");
    expect(getToolCatalog().map((t) => t.name)).toEqual(["end_call"]);
    expect(resolveEffectiveTools({ enabledTools: SALES_TOOLS, enabledModules: ["sales"], context: FULL_CONTEXT })).toEqual(["end_call"]);
    expect(getToolDefinitions().map((t) => t.name)).toEqual(["end_call"]);
  });

  it("refuses to execute a Sales tool even when handed it in an allow-list", async () => {
    unregisterModule("sales");
    for (const name of SALES_TOOLS) {
      expect(await executeTool(name, {}, { organizationId: "o", callId: "c", subject: { leadId: "l", projectId: "p" } }, SALES_TOOLS)).toEqual({
        error: `Unknown tool: ${name}`,
      });
    }
  });

  it("gives every agent the generic prompt and the generic summary", async () => {
    unregisterModule("sales");
    for (const key of [undefined, "generic", "sales_real_estate"] as const) {
      const p = buildSystemPrompt({ leadName: "Ravi", projectName: "Green Valley" }, key ? { promptTemplateKey: key } : null);
      expect(p).not.toMatch(/real-estate|Green Valley|site visit/i);
    }
    const summary = await generateCallSummary(new MockLlmProvider(), TRANSCRIPT);
    expect(isGenericSummary(summary)).toBe(true);
  });
});

describe("an empty tool list never means all tools", () => {
  it("is strict in the registry: only end_call", async () => {
    expect(getToolDefinitions([]).map((t) => t.name)).toEqual(["end_call"]);
    expect(await executeTool("get_project_price", {}, { organizationId: "o", callId: "c" }, [])).toEqual({ error: "Unknown tool: get_project_price" });
  });

  it("an agent selecting nothing still gets exactly end_call from the resolver", () => {
    expect(resolveEffectiveTools({ enabledTools: [], enabledModules: ["sales"], context: FULL_CONTEXT })).toEqual(["end_call"]);
  });
});

describe("the core with the Sales module registered", () => {
  it("offers only the Sales tools the agent explicitly enabled", () => {
    expect(registeredModuleKeys()).toContain("sales");
    expect(resolveEffectiveTools({ enabledTools: ["get_project_price", "update_lead"], enabledModules: ["sales"], context: FULL_CONTEXT })).toEqual([
      "get_project_price",
      "update_lead",
      "end_call",
    ]);
  });

  it("an agent without a template key still gets the real-estate prompt and summary (legacy default)", async () => {
    expect(buildSystemPrompt({ leadName: "Ravi", projectName: "GV" })).toContain("real-estate sales");
    const summary = await generateCallSummary(new MockLlmProvider(), TRANSCRIPT);
    expect(isGenericSummary(summary)).toBe(false);
  });
});
