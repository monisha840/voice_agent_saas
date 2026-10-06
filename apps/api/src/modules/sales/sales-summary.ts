/**
 * The Sales module's post-call summary profile: the real-estate qualification summary (configuration, budget,
 * loan, recommended lead status, site-visit state). Moved here from the core summary file unchanged; the core
 * reaches it only through the summary-profile registry. The prompt text is what the mock LLM keys off.
 */
import type { ILanguageModel } from "../../adapters/ai/llm.interface.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";
import { logger } from "../../shared/logger.js";
import { SUMMARY_TOOL_NAME, isOneOf } from "../ai-agent/post-call-summary.js";

export const SALES_SUMMARY_PROFILE = "sales_real_estate";

export interface QualificationData {
  summary: string;
  interestLevel: "high" | "medium" | "low" | "unknown";
  configuration: string | null;
  budget: string | null;
  purchaseTimeline: string | null;
  loanRequirement: string | null;
  locationPreference: string | null;
  customerQuestions: string[];
  siteVisitStatus: "booked" | "offered" | "declined" | "not_discussed";
  recommendedNextAction: string;
  recommendedLeadStatus:
    | "INTERESTED"
    | "NOT_INTERESTED"
    | "VISIT_BOOKED"
    | "FOLLOW_UP"
    | "QUALIFICATION";
}

function buildSummaryPrompt(transcript: TranscriptTurn[]): string {
  const transcriptText = transcript.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  return `Below is the full transcript of a real-estate sales call. Analyze it and call the ${SUMMARY_TOOL_NAME} tool with a structured summary. Base every field only on what was actually said — do not invent details.

TRANSCRIPT:
${transcriptText}`;
}

function summaryToolDefinition() {
  return {
    name: SUMMARY_TOOL_NAME,
    description: "Emit a structured summary of the completed call.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        interestLevel: { type: "string", enum: ["high", "medium", "low", "unknown"] },
        configuration: { type: "string" },
        budget: { type: "string" },
        purchaseTimeline: { type: "string" },
        loanRequirement: { type: "string" },
        locationPreference: { type: "string" },
        customerQuestions: { type: "array", items: { type: "string" } },
        siteVisitStatus: { type: "string", enum: ["booked", "offered", "declined", "not_discussed"] },
        recommendedNextAction: { type: "string" },
        recommendedLeadStatus: {
          type: "string",
          enum: ["INTERESTED", "NOT_INTERESTED", "VISIT_BOOKED", "FOLLOW_UP", "QUALIFICATION"],
        },
      },
      required: ["summary", "interestLevel", "recommendedLeadStatus"],
    },
  };
}

function fallbackQualification(reason: string): QualificationData {
  return {
    summary: `Summary unavailable (${reason}). See raw transcript.`,
    interestLevel: "unknown",
    configuration: null,
    budget: null,
    purchaseTimeline: null,
    loanRequirement: null,
    locationPreference: null,
    customerQuestions: [],
    siteVisitStatus: "not_discussed",
    recommendedNextAction: "Manual review required",
    recommendedLeadStatus: "FOLLOW_UP",
  };
}

export async function generateSalesSummary(llm: ILanguageModel, transcript: TranscriptTurn[]): Promise<QualificationData> {
  if (transcript.length === 0) {
    return fallbackQualification("empty transcript");
  }

  try {
    const result = await llm.chat(
      [{ role: "user", content: buildSummaryPrompt(transcript) }],
      [summaryToolDefinition()],
    );

    const call = result.toolCalls?.[0];
    if (!call) {
      // Model answered in plain text instead of calling the tool — fall
      // back to a minimal summary built from that text rather than
      // fabricating structured fields we don't actually have.
      return {
        ...fallbackQualification("model did not return structured output"),
        summary: result.content?.slice(0, 500) || fallbackQualification("empty response").summary,
      };
    }

    return normalizeQualification(call.arguments);
  } catch (err) {
    logger.error("post-call-summary: generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallbackQualification("summary generation failed");
  }
}


function normalizeQualification(args: Record<string, unknown>): QualificationData {
  const base = fallbackQualification("partial data");
  return {
    summary: typeof args.summary === "string" ? args.summary : base.summary,
    interestLevel: isOneOf(args.interestLevel, ["high", "medium", "low", "unknown"])
      ? args.interestLevel
      : "unknown",
    configuration: typeof args.configuration === "string" ? args.configuration : null,
    budget: typeof args.budget === "string" ? args.budget : null,
    purchaseTimeline: typeof args.purchaseTimeline === "string" ? args.purchaseTimeline : null,
    loanRequirement: typeof args.loanRequirement === "string" ? args.loanRequirement : null,
    locationPreference: typeof args.locationPreference === "string" ? args.locationPreference : null,
    customerQuestions: Array.isArray(args.customerQuestions)
      ? args.customerQuestions.filter((q): q is string => typeof q === "string")
      : [],
    siteVisitStatus: isOneOf(args.siteVisitStatus, ["booked", "offered", "declined", "not_discussed"])
      ? args.siteVisitStatus
      : "not_discussed",
    recommendedNextAction:
      typeof args.recommendedNextAction === "string" ? args.recommendedNextAction : base.recommendedNextAction,
    recommendedLeadStatus: isOneOf(args.recommendedLeadStatus, [
      "INTERESTED",
      "NOT_INTERESTED",
      "VISIT_BOOKED",
      "FOLLOW_UP",
      "QUALIFICATION",
    ])
      ? args.recommendedLeadStatus
      : "FOLLOW_UP",
  };
}
