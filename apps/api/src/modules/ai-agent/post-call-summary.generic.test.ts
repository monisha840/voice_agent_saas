import { describe, it, expect } from "vitest";
import {
  generateCallSummary,
  isGenericSummary,
  normalizeGenericSummary,
  type GenericSummaryData,
} from "./post-call-summary.js";
import { MockLlmProvider, mockGreeting } from "../../adapters/ai/mock.llm.provider.js";
import { buildSystemPrompt } from "./persona.js";
import type { ILanguageModel, ChatMessage, ToolDefinition, ChatResult } from "../../adapters/ai/llm.interface.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";

class CapturingLlm implements ILanguageModel {
  readonly name = "capture";
  lastPrompt = "";
  lastTools: ToolDefinition[] = [];
  constructor(private readonly response: ChatResult | Error) {}
  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    this.lastPrompt = messages[messages.length - 1].content;
    this.lastTools = tools;
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

const TRANSCRIPT: TranscriptTurn[] = [
  { speaker: "ai", text: "Hello! How can I help?", timestamp: "t1" },
  { speaker: "lead", text: "My name is Asha. Please call me back, thanks. asha@example.com", timestamp: "t2" },
  { speaker: "ai", text: "Sure, a colleague will call back.", timestamp: "t3" },
];

describe("generic summary", () => {
  it("normalizes a well-formed response", async () => {
    const llm = new CapturingLlm({
      toolCalls: [
        {
          id: "1",
          name: "emit_call_summary",
          arguments: {
            summary: "Caller asked for a callback.",
            outcome: "follow_up_needed",
            sentiment: "positive",
            keyPoints: ["Wants callback"],
            recommendedNextAction: "Call back",
            contact: { name: "Asha", email: "asha@example.com" },
            extracted: { topic: "billing" },
          },
        },
      ],
    });
    const r = await generateCallSummary(llm, TRANSCRIPT, "generic");
    expect(r).toEqual({
      profile: "generic",
      summary: "Caller asked for a callback.",
      outcome: "follow_up_needed",
      sentiment: "positive",
      keyPoints: ["Wants callback"],
      recommendedNextAction: "Call back",
      contact: { name: "Asha", phone: null, email: "asha@example.com" },
      extracted: { topic: "billing" },
    });
    expect(isGenericSummary(r)).toBe(true);
    expect(llm.lastTools[0].name).toBe("emit_call_summary");
  });

  it("never trusts garbage shapes", () => {
    const r = normalizeGenericSummary({
      summary: 42,
      outcome: "great",
      sentiment: ["x"],
      keyPoints: "nope",
      recommendedNextAction: {},
      contact: "me",
      extracted: [1, 2],
    });
    expect(r.profile).toBe("generic");
    expect(r.outcome).toBe("unknown");
    expect(r.sentiment).toBe("unknown");
    expect(r.keyPoints).toEqual([]);
    expect(r.recommendedNextAction).toBe("Manual review required");
    expect(r.contact).toEqual({ name: null, phone: null, email: null });
    expect(r.extracted).toEqual({});
    expect(normalizeGenericSummary(null).profile).toBe("generic");
    expect(normalizeGenericSummary("str").outcome).toBe("unknown");
  });

  it("limits extracted to 20 string entries and truncates strings", () => {
    const extracted: Record<string, unknown> = { num: 5, obj: {}, nul: null };
    for (let i = 0; i < 50; i++) extracted[`k${i}`] = "v".repeat(5000);
    const r = normalizeGenericSummary({
      summary: "s".repeat(10_000),
      keyPoints: Array.from({ length: 50 }, (_, i) => `p${i}`).concat([1 as unknown as string]),
      extracted,
    });
    expect(Object.keys(r.extracted)).toHaveLength(20);
    expect(r.extracted.num).toBeUndefined();
    expect(Object.values(r.extracted).every((v) => v.length <= 400)).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(2000);
    expect(r.keyPoints).toHaveLength(20);
  });

  it("falls back for empty transcript without calling the model", async () => {
    const llm = new CapturingLlm({ content: "unused" });
    const r = await generateCallSummary(llm, [], "generic");
    expect(llm.lastPrompt).toBe("");
    expect(r.outcome).toBe("unknown");
    expect(r.summary).toContain("empty transcript");
  });

  it("falls back on plain text and on thrown errors", async () => {
    const plain = await generateCallSummary(new CapturingLlm({ content: "Caller was polite." }), TRANSCRIPT, "generic");
    expect(plain.summary).toBe("Caller was polite.");
    expect(plain.profile).toBe("generic");
    const failed = await generateCallSummary(new CapturingLlm(new Error("boom")), TRANSCRIPT, "generic");
    expect(failed.summary).toContain("summary generation failed");
    expect(failed.recommendedNextAction).toBe("Manual review required");
  });

  it("generic prompt has no real-estate wording and keeps the grounding rule", async () => {
    const llm = new CapturingLlm({ content: "x" });
    await generateCallSummary(llm, TRANSCRIPT, "generic");
    const all = (llm.lastPrompt + JSON.stringify(llm.lastTools)).toLowerCase();
    for (const word of ["real-estate", "real estate", "lead", "budget"]) {
      // transcript speaker label "LEAD:" is data, so strip transcript before checking
      const preamble = llm.lastPrompt.split("TRANSCRIPT:")[0].toLowerCase() + JSON.stringify(llm.lastTools).toLowerCase();
      expect(preamble).not.toContain(word);
    }
    expect(all).toContain("base every field only on what was actually said");
    expect(llm.lastPrompt).toContain("SUMMARY_PROFILE: generic");
  });

  it("mock LLM returns generic-shaped output for the generic prompt", async () => {
    const r = await generateCallSummary(new MockLlmProvider(), TRANSCRIPT, "generic");
    expect(r.profile).toBe("generic");
    expect(r.outcome).toBe("follow_up_needed");
    expect(r.contact.name).toBe("Asha");
    expect(r.contact.email).toBe("asha@example.com");
    expect(r.sentiment).toBe("positive");
  });
});

describe("sales profile unchanged", () => {
  it("default and explicit profile yield identical QualificationData via the mock", async () => {
    const t: TranscriptTurn[] = [
      { speaker: "ai", text: "Hi", timestamp: "1" },
      { speaker: "lead", text: "2 BHK around 70 lakh", timestamp: "2" },
      { speaker: "ai", text: "Your visit is booked.", timestamp: "3" },
    ];
    const a = await generateCallSummary(new MockLlmProvider(), t);
    const b = await generateCallSummary(new MockLlmProvider(), t, "sales_real_estate");
    expect(a).toEqual(b);
    expect(a).toEqual({
      summary: "Lead is looking for a 2 BHK with a budget of INR 70 lakh and a site visit was booked. (mock summary)",
      interestLevel: "high",
      configuration: "2 BHK",
      budget: "INR 70 lakh",
      customerQuestions: [],
      siteVisitStatus: "booked",
      recommendedNextAction: "Send visit confirmation and reminder",
      recommendedLeadStatus: "VISIT_BOOKED",
      purchaseTimeline: null,
      loanRequirement: null,
      locationPreference: null,
    });
    expect("profile" in a).toBe(false);
    expect(isGenericSummary(a)).toBe(false);
  });
});

describe("mock greeting", () => {
  const LEGACY = "Hello! This is Priya, an AI assistant calling from Green Valley Developers. Is this a good time to talk?";
  const greet = async (system: string | undefined) => {
    const messages: ChatMessage[] = [
      ...(system !== undefined ? [{ role: "system" as const, content: system }] : []),
      { role: "user", content: "[Call connected. Begin the conversation with your introduction.]" },
    ];
    return (await new MockLlmProvider().chat(messages, [])).content;
  };

  it("is character-for-character identical for the legacy sales prompt", async () => {
    const sys = buildSystemPrompt({ leadName: "Ravi", projectName: "Green Valley" });
    expect(await greet(sys)).toBe(LEGACY);
    expect(mockGreeting(sys)).toBe(LEGACY);
    expect(await greet(undefined)).toBe(LEGACY);
  });

  it("follows a custom agent name and company in the legacy prompt shape", async () => {
    const sys = buildSystemPrompt(
      { leadName: "Ravi", projectName: "Sky Towers" },
      { agentName: "Meera", companyName: "Sky Homes" },
    );
    expect(await greet(sys)).toBe(
      "Hello! This is Meera, an AI assistant calling from Sky Homes. Is this a good time to talk?",
    );
  });

  it("has no company/brand for generic prompts", async () => {
    const g = await greet("You are Alex, an AI voice assistant. Help the person on the phone.");
    expect(g).toBe("Hello! This is Alex, an AI assistant. How can I help?");
    expect(g).not.toMatch(/Green Valley|Priya/);
    const inbound = await greet("You are Sam, an AI voice assistant. The caller called us for support.");
    expect(inbound).toBe("Hello! Thanks for calling. This is Sam, an AI assistant. How can I help you today?");
    expect(await greet("Be helpful.")).toBe("Hello! I am an AI assistant. How can I help?");
  });
});

// type-level sanity: overloads
const _typed: Promise<GenericSummaryData> = generateCallSummary(new CapturingLlm({ content: "" }), [], "generic");
void _typed;
