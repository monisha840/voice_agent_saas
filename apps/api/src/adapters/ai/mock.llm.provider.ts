/**
 * Mock LLM — deterministic, rule-based "model" used for local dev and
 * automated tests without Sarvam credentials. It inspects the latest
 * user message plus any tool results produced *in the current turn* and
 * returns either a canned tool call or a canned spoken response, so the
 * surrounding orchestration (tool execution, transcript persistence,
 * post-call summary) can be exercised end-to-end without a real LLM.
 *
 * Scripted booking flow (driven by the local call simulator):
 *   project interest  -> get_project_details
 *   config + budget   -> update_lead
 *   "visit"           -> check_visit_slots   (then offers the slots)
 *   "11:30 AM" etc.   -> book_site_visit     (using a slot from check_visit_slots)
 *
 * This is NOT a simulation of a successful real call — see the
 * ai-tools tests and conversation/e2e tests, which label results
 * accordingly.
 */
import type { ChatMessage, ChatResult, ILanguageModel, ToolDefinition } from "./llm.interface.js";

const SUMMARY_TOOL_NAME = "emit_call_summary";
/** Line placed in the generic-profile summary prompt (see post-call-summary.ts). */
const GENERIC_SUMMARY_MARKER = "SUMMARY_PROFILE: generic";

interface Slot {
  label: string;
  isoDateTime: string;
}

export class MockLlmProvider implements ILanguageModel {
  readonly name = "mock-llm";

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const hasTool = (toolName: string) => tools.some((t) => t.name === toolName);

    if (hasTool(SUMMARY_TOOL_NAME)) {
      const prompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const args = prompt.includes(GENERIC_SUMMARY_MARKER) ? buildMockGenericSummary(prompt) : buildMockSummary(prompt);
      return {
        toolCalls: [{ id: "mock-summary", name: SUMMARY_TOOL_NAME, arguments: args }],
      };
    }

    const lastUserIdx = findLastIndex(messages, (m) => m.role === "user");
    const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
    const turnTool = messages.slice(lastUserIdx + 1).reverse().find((m) => m.role === "tool");

    // After a tool result comes back, respond with text referencing it.
    if (turnTool) return { content: respondToToolResult(messages, turnTool) };

    const raw = lastUser?.content ?? "";
    const text = raw.toLowerCase();
    const callId = `mock-${messages.length}`;
    const call = (name: string, args: Record<string, unknown> = {}): ChatResult => ({
      toolCalls: [{ id: callId, name, arguments: args }],
    });

    if (raw.startsWith("[Call connected")) {
      return { content: mockGreeting(messages.find((m) => m.role === "system")?.content) };
    }
    if (text.includes("price") && hasTool("get_project_price")) {
      return call("get_project_price", { configuration: "2 BHK" });
    }
    if (text.includes("visit") && hasTool("check_visit_slots")) {
      return call("check_visit_slots");
    }
    const timeMatch = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (timeMatch && hasTool("book_site_visit")) {
      const wanted = `${Number(timeMatch[1])}:${timeMatch[2]} ${timeMatch[3].toUpperCase()}`;
      const slot = offeredSlots(messages).find((s) => s.label.includes(wanted));
      if (slot) return call("book_site_visit", { isoDateTime: slot.isoDateTime });
    }
    const bhk = raw.match(/(\d)\s*bhk/i);
    const lakh = raw.match(/(\d+(?:\.\d+)?)\s*lakh/i);
    if ((bhk || lakh) && hasTool("update_lead")) {
      const budget = lakh ? Math.round(Number(lakh[1]) * 100_000) : undefined;
      return call("update_lead", {
        ...(bhk ? { requirementConfig: `${bhk[1]} BHK` } : {}),
        ...(budget ? { budgetMin: budget, budgetMax: budget } : {}),
      });
    }
    if ((text.includes("green valley") || text.includes("interested")) && hasTool("get_project_details")) {
      return call("get_project_details");
    }
    return { content: "Hello! This is a mock AI response for local development/testing." };
  }
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function parseJson(content: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(content);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Slots from the most recent check_visit_slots result in the history. */
function offeredSlots(messages: ChatMessage[]): Slot[] {
  for (const m of [...messages].reverse()) {
    if (m.role !== "tool") continue;
    const slots = parseJson(m.content).slots;
    if (Array.isArray(slots)) return slots as Slot[];
  }
  return [];
}

function respondToToolResult(messages: ChatMessage[], toolMsg: ChatMessage): string {
  const toolName = messages.find((m) => m.role === "assistant" && m.toolCallId === toolMsg.toolCallId)?.toolName;
  const result = parseJson(toolMsg.content);
  switch (toolName) {
    case "get_project_details":
      return `Great! ${String(result.name ?? "The project")} is located in ${String(result.location ?? "a prime area")}. Which configuration are you looking for, and what is your budget?`;
    case "update_lead":
      return "Thanks, I have noted your requirement and budget. Would you like to visit the site? I can check available slots.";
    case "check_visit_slots": {
      const labels = (Array.isArray(result.slots) ? (result.slots as Slot[]) : []).map((s) => s.label);
      return `I have these slots available: ${labels.join(", ")}. Which one works for you?`;
    }
    case "book_site_visit":
      return result.booked
        ? "Your site visit is booked. Thank you, we look forward to seeing you!"
        : "Sorry, I could not book that slot. A colleague will follow up with you.";
    default:
      return `Noted. (mock response following tool result: ${toolMsg.content.slice(0, 80)})`;
  }
}

const LEGACY_GREETING =
  "Hello! This is Priya, an AI assistant calling from Green Valley Developers. Is this a good time to talk?";

/** Opening line derived from the system prompt's persona; legacy sales prompts keep the original sentence shape. */
export function mockGreeting(systemPrompt: string | undefined): string {
  if (systemPrompt === undefined) return LEGACY_GREETING;
  const name = systemPrompt.match(/You are ([^,.\n]+?), an? (?:AI )?voice assistant\b/i)?.[1]?.trim();
  const company = systemPrompt.match(/on behalf of ([^\n]+?)(?: about\b|[.,\n]|$)/i)?.[1]?.trim();
  if (name && company) {
    return `Hello! This is ${name}, an AI assistant calling from ${company}. Is this a good time to talk?`;
  }
  const intro = name ? `This is ${name}, an AI assistant.` : "I am an AI assistant.";
  if (/\b(?:caller|customer|user) (?:has )?(?:called|calling) (?:us|in)\b|\binbound\b|\bincoming call\b/i.test(systemPrompt)) {
    return `Hello! Thanks for calling. ${intro} How can I help you today?`;
  }
  return `Hello! ${intro} How can I help?`;
}

/** Deterministic generic-profile emit_call_summary payload built from the transcript in the prompt. */
function buildMockGenericSummary(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const callerLines = lines
    .filter((l) => /^(LEAD|CALLER|USER):/.test(l))
    .map((l) => l.slice(l.indexOf(":") + 1).trim());
  const aiText = lines.filter((l) => l.startsWith("AI:")).join(" ").toLowerCase();
  const callerText = callerLines.join(" ");
  const email = callerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = callerText.match(/\+?\d[\d\s-]{8,}\d/)?.[0];
  const name = callerText.match(/\b(?:[Mm]y name is|[Tt]his is|[Ii] am|[Ii]'m)\s+([A-Z][a-z]+)/)?.[1];
  const negative = /not (?:happy|satisfied|interested)|complain|angry|worst/i.test(callerText);
  const positive = /thank|great|perfect|appreciate/i.test(callerText);
  const followUp = /follow up|call (?:you )?back|callback|get back/.test(aiText);
  const resolved = /\b(?:booked|confirmed|done|resolved)\b/.test(aiText);
  const outcome = resolved
    ? "resolved"
    : followUp
      ? "follow_up_needed"
      : callerLines.length > 0
        ? "no_resolution"
        : "unknown";
  return {
    summary: `The caller sent ${callerLines.length} message(s) during the call. (mock summary)`,
    outcome,
    sentiment: negative ? "negative" : positive ? "positive" : callerLines.length > 0 ? "neutral" : "unknown",
    keyPoints: callerLines.filter((l) => l.length > 0).slice(0, 5),
    recommendedNextAction: outcome === "resolved" ? "No action needed" : "Follow up with the caller",
    contact: { ...(name ? { name } : {}), ...(phone ? { phone } : {}), ...(email ? { email } : {}) },
    extracted: {},
  };
}

/** Builds a deterministic emit_call_summary payload from the transcript embedded in the summary prompt. */
function buildMockSummary(prompt: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const leadLines = lines.filter((l) => l.startsWith("LEAD:")).map((l) => l.slice(5).trim());
  const aiText = lines.filter((l) => l.startsWith("AI:")).join(" ").toLowerCase();
  const leadText = leadLines.join(" ");

  const configuration = leadText.match(/(\d)\s*bhk/i)?.[0].toUpperCase() ?? undefined;
  const lakh = leadText.match(/(\d+(?:\.\d+)?)\s*lakh/i);
  const budget = lakh ? `INR ${lakh[1]} lakh` : undefined;
  const booked = aiText.includes("booked");
  const offered = aiText.includes("slots");
  const notInterested = /not interested/i.test(leadText);

  const siteVisitStatus = booked ? "booked" : offered ? "offered" : "not_discussed";
  const recommendedLeadStatus = notInterested
    ? "NOT_INTERESTED"
    : booked
      ? "VISIT_BOOKED"
      : configuration || budget
        ? "INTERESTED"
        : "QUALIFICATION";

  const parts = [
    configuration ? `Lead is looking for a ${configuration}` : "Lead enquired about the project",
    budget ? `with a budget of ${budget}` : null,
    booked ? "and a site visit was booked." : offered ? "and was offered site-visit slots." : ".",
  ].filter(Boolean);

  return {
    summary: `${parts.join(" ")} (mock summary)`.replace(" .", "."),
    interestLevel: booked ? "high" : leadLines.length > 0 ? "medium" : "unknown",
    ...(configuration ? { configuration } : {}),
    ...(budget ? { budget } : {}),
    customerQuestions: leadLines.filter((l) => l.includes("?")),
    siteVisitStatus,
    recommendedNextAction: booked ? "Send visit confirmation and reminder" : "Follow up with the lead",
    recommendedLeadStatus,
  };
}
