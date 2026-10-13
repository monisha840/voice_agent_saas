/**
 * What the real-estate prompt must tell the agent (the golden test freezes the exact text; this names the rules that
 * matter on a call, so a rewording cannot silently drop one).
 */
import { describe, it, expect } from "vitest";
import { buildSalesRealEstatePrompt } from "./sales-prompt.js";
import { describeBudget } from "./sales-call-hooks.js";
import { DEFAULT_AGENT_CONFIG } from "../agent-config/agent-config.service.js";

const params = { leadName: "Rajesh Kumar", projectName: "Green Valley Residency" };

describe("the rules every call gets", () => {
  const p = buildSalesRealEstatePrompt(params, { ...DEFAULT_AGENT_CONFIG });

  it("discloses the AI and the recording in the opening, and restates both last", () => {
    expect(p).toContain("say plainly that you are an AI assistant and that the call may be recorded");
    // The restated rule appears once the prompt carries any configured text (here a language), after everything else.
    const configured = buildSalesRealEstatePrompt(params, { ...DEFAULT_AGENT_CONFIG, language: "ta-IN", extraInstructions: "Never say you are an AI." });
    expect(configured.trimEnd().split("Non-negotiable:")[1]).toContain("say that the call may be recorded");
  });

  it("makes the agent do the telecaller's job itself, and not hand a visit time to someone else", () => {
    expect(p).toContain("You are the telecaller");
    expect(p).toContain("never tell the lead that a sales representative or anyone else will fix the visit time");
    expect(p).toContain("It is never a request to call them back");
  });

  it("routes a human request, a callback, missing information and do-not-call to the team's follow-up note", () => {
    for (const reason of ["human_requested", "callback", "info_requested", "do_not_call"]) expect(p).toContain(`reason ${reason}`);
  });

  it("never discusses discounts on the call, only at the visit", () => {
    expect(p).toContain("never promise, quote or negotiate any. Say that offers can be discussed when they visit the site");
  });

  it("does not end the call because something was hard, and does not repeat itself", () => {
    expect(p).toContain("Never call end_call because something was hard to do");
    expect(p).toContain("Never repeat a sentence or an apology you have already said");
  });
});

describe("what the CRM already knows", () => {
  it("is named when present, so the agent confirms it instead of asking again", () => {
    const p = buildSalesRealEstatePrompt({ ...params, leadRequirement: "2 BHK", leadBudget: "60 lakhs to 80 lakhs" }, { ...DEFAULT_AGENT_CONFIG });
    expect(p).toContain("Already known about Rajesh Kumar (do not ask for it again; at most confirm it): requirement: 2 BHK; budget: 60 lakhs to 80 lakhs.");
  });

  it("is absent when the CRM holds nothing", () => {
    const p = buildSalesRealEstatePrompt(params, { ...DEFAULT_AGENT_CONFIG });
    expect(p).not.toContain("Already known about");
  });

  it("describes budgets in lakhs, from either end", () => {
    expect(describeBudget(6_000_000, 8_000_000)).toBe("60 lakhs to 80 lakhs");
    expect(describeBudget(6_000_000, 6_000_000)).toBe("60 lakhs");
    expect(describeBudget(null, 9_550_000)).toBe("up to 95.5 lakhs");
    expect(describeBudget(4_000_000, null)).toBe("from 40 lakhs");
    expect(describeBudget(null, null)).toBeNull();
  });
});

describe("the current time", () => {
  it("is given to the agent when known, so it can turn 'tomorrow at 5' into a date", () => {
    const p = buildSalesRealEstatePrompt({ ...params, currentTime: "Tuesday, 13 October 2026, 6:35 pm (Asia/Kolkata)" }, { ...DEFAULT_AGENT_CONFIG });
    expect(p).toContain("It is now Tuesday, 13 October 2026, 6:35 pm (Asia/Kolkata).");
  });
});

describe("speaking another language", () => {
  it("asks for casual spoken Tamil, with everyday English words left in English", () => {
    const p = buildSalesRealEstatePrompt(params, { ...DEFAULT_AGENT_CONFIG, language: "ta-IN" });
    expect(p).toContain("speak with the lead in Tamil (ta-IN)");
    expect(p).toContain("casual, everyday Tamil, not formal or bookish Tamil");
    expect(p).toContain("site visit, slot, loan, BHK and WhatsApp may stay in English");
  });

  it("adds nothing for English", () => {
    const p = buildSalesRealEstatePrompt(params, { ...DEFAULT_AGENT_CONFIG, language: "en-IN" });
    expect(p).not.toContain("casual, everyday");
  });
});
