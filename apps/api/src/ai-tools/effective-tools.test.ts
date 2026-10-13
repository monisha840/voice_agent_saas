import { describe, it, expect } from "vitest";
import { resolveEffectiveTools } from "./effective-tools.js";
import { ALL_TOOL_NAMES, CORE_TOOL_NAMES, executeTool, getToolCatalog } from "./index.js";

const all = { lead: true, project: true };

describe("tool catalog", () => {
  it("tags every tool and keeps end_call as the only core tool", () => {
    const catalog = getToolCatalog();
    expect(catalog.map((t) => t.name)).toEqual([...ALL_TOOL_NAMES]);
    expect(CORE_TOOL_NAMES).toEqual(["end_call"]);
    const by = Object.fromEntries(catalog.map((t) => [t.name, t]));
    expect(by.get_project_price).toMatchObject({ module: "sales", requires: ["project"] });
    expect(by.book_site_visit).toMatchObject({ module: "sales", requires: ["lead", "project"] });
    expect(by.update_lead).toMatchObject({ module: "sales", requires: ["lead"] });
    expect(by.end_call).toMatchObject({ module: "core", requires: [] });
  });
});

describe("resolveEffectiveTools", () => {
  it("sales on, lead + project: the agent's selection in registry order", () => {
    expect(
      resolveEffectiveTools({ enabledTools: ["update_lead", "get_project_price"], enabledModules: ["sales"], context: all }),
    ).toEqual(["get_project_price", "update_lead", "end_call"]);
  });

  it("sales module off drops every sales tool", () => {
    expect(resolveEffectiveTools({ enabledTools: [...ALL_TOOL_NAMES], enabledModules: [], context: all })).toEqual(["end_call"]);
  });

  it("no lead and no project leaves only core", () => {
    expect(
      resolveEffectiveTools({ enabledTools: [...ALL_TOOL_NAMES], enabledModules: ["sales"], context: { lead: false, project: false } }),
    ).toEqual(["end_call"]);
  });

  it("lead without project keeps lead-only tools", () => {
    expect(
      resolveEffectiveTools({ enabledTools: [...ALL_TOOL_NAMES], enabledModules: ["sales"], context: { lead: true, project: false } }),
    ).toEqual(["update_lead", "mark_not_interested", "end_call"]);
  });

  it("project without lead keeps project-only tools", () => {
    expect(
      resolveEffectiveTools({ enabledTools: [...ALL_TOOL_NAMES], enabledModules: ["sales"], context: { lead: false, project: true } }),
    ).toEqual(["get_project_details", "get_project_price", "get_project_configurations", "get_project_location", "request_follow_up", "end_call"]);
  });

  it("empty enabledTools is explicit end_call only, never an empty list", () => {
    expect(resolveEffectiveTools({ enabledTools: [], enabledModules: ["sales"], context: all })).toEqual(["end_call"]);
  });

  it("drops unknown names and de-duplicates", () => {
    expect(
      resolveEffectiveTools({
        enabledTools: ["nope", "get_project_price", "get_project_price", "end_call", "end_call"],
        enabledModules: ["sales", "unknown-module"],
        context: all,
      }),
    ).toEqual(["get_project_price", "end_call"]);
  });

  it("two agents in the same org and call get different tools", () => {
    const a = resolveEffectiveTools({ enabledTools: ["get_project_price"], enabledModules: ["sales"], context: all });
    const b = resolveEffectiveTools({ enabledTools: ["book_site_visit", "check_visit_slots"], enabledModules: ["sales"], context: all });
    expect(a).not.toEqual(b);
    expect(b).toEqual(["check_visit_slots", "book_site_visit", "end_call"]);
  });
});

describe("sales tools without a lead/project on the call", () => {
  const ctx = { organizationId: "org", callId: "call" };
  it("return a structured error instead of throwing", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["get_project_details", {}, "project"],
      ["get_project_price", {}, "project"],
      ["get_project_configurations", {}, "project"],
      ["get_project_location", {}, "project"],
      ["check_visit_slots", {}, "lead"],
      ["book_site_visit", { isoDateTime: "2030-01-01T10:00:00Z" }, "lead"],
      ["update_lead", {}, "lead"],
      ["mark_not_interested", {}, "lead"],
    ];
    for (const [name, args, what] of cases) {
      expect(await executeTool(name, args, ctx)).toEqual({ error: `${name} needs a ${what} on this call` });
    }
    expect(await executeTool("book_site_visit", { isoDateTime: "x" }, { ...ctx, subject: { leadId: "l" } })).toEqual({
      error: "book_site_visit needs a project on this call",
    });
  });
});
