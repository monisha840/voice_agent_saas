import { describe, it, expect } from "vitest";
import { generateCallSummary } from "./post-call-summary.js";
import type { ILanguageModel, ChatMessage, ToolDefinition, ChatResult } from "../../adapters/ai/llm.interface.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";

/** Stub LLM that returns a fixed structured tool call, to test parsing in isolation. */
class StubSummaryLlm implements ILanguageModel {
  readonly name = "stub";
  constructor(private readonly response: ChatResult) {}
  async chat(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatResult> {
    return this.response;
  }
}

const SAMPLE_TRANSCRIPT: TranscriptTurn[] = [
  { speaker: "ai", text: "Hi, this is Priya from Green Valley Developers.", timestamp: "t1" },
  { speaker: "lead", text: "Yes I'm looking for a 2 BHK around 70 lakhs.", timestamp: "t2" },
  { speaker: "ai", text: "We have a slot this Saturday at 11:30 AM, would that work?", timestamp: "t3" },
  { speaker: "lead", text: "Yes that works.", timestamp: "t4" },
];

describe("generateCallSummary", () => {
  it("parses a well-formed structured tool-call response into QualificationData", async () => {
    const llm = new StubSummaryLlm({
      toolCalls: [
        {
          id: "1",
          name: "emit_call_summary",
          arguments: {
            summary: "Lead wants a 2 BHK and booked a site visit.",
            interestLevel: "high",
            configuration: "2 BHK",
            budget: "70L",
            siteVisitStatus: "booked",
            recommendedLeadStatus: "VISIT_BOOKED",
            customerQuestions: ["What amenities are included?"],
          },
        },
      ],
    });

    const result = await generateCallSummary(llm, SAMPLE_TRANSCRIPT);

    expect(result.interestLevel).toBe("high");
    expect(result.configuration).toBe("2 BHK");
    expect(result.siteVisitStatus).toBe("booked");
    expect(result.recommendedLeadStatus).toBe("VISIT_BOOKED");
    expect(result.customerQuestions).toEqual(["What amenities are included?"]);
  });

  it("falls back to a safe default when the model returns plain text instead of a tool call", async () => {
    const llm = new StubSummaryLlm({ content: "The lead seemed interested." });
    const result = await generateCallSummary(llm, SAMPLE_TRANSCRIPT);

    expect(result.recommendedLeadStatus).toBe("FOLLOW_UP");
    expect(result.summary).toContain("The lead seemed interested");
  });

  it("falls back to a safe default for an empty transcript without calling the model", async () => {
    let called = false;
    const llm = new StubSummaryLlm({ content: "should not be used" });
    const originalChat = llm.chat.bind(llm);
    llm.chat = async (...args) => {
      called = true;
      return originalChat(...args);
    };

    const result = await generateCallSummary(llm, []);
    expect(called).toBe(false);
    expect(result.recommendedLeadStatus).toBe("FOLLOW_UP");
  });

  it("rejects an out-of-enum recommendedLeadStatus rather than trusting the model blindly", async () => {
    const llm = new StubSummaryLlm({
      toolCalls: [
        {
          id: "1",
          name: "emit_call_summary",
          arguments: { summary: "test", interestLevel: "high", recommendedLeadStatus: "MADE_UP_STATUS" },
        },
      ],
    });

    const result = await generateCallSummary(llm, SAMPLE_TRANSCRIPT);
    expect(result.recommendedLeadStatus).toBe("FOLLOW_UP");
  });
});
