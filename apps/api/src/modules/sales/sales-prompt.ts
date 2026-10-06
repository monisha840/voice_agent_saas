/**
 * The Sales module's real-estate system prompt. The text is frozen byte-for-byte by persona.golden.test.ts; it
 * moved here from the core persona file unchanged. The core reaches it only through the prompt-template registry.
 *
 * It contains NO project facts: those come at runtime from project knowledge via the Sales tools, per the rule
 * that the agent must never invent project information.
 */
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import { AGENT_NAME, COMPANY_NAME, LANGUAGE_NAME, TONE_PHRASE, int, optStr, str, type PromptParams } from "../ai-agent/persona.js";

/** The real-estate sales template. Text is frozen by persona.golden.test.ts. */
export function buildSalesRealEstatePrompt(params: PromptParams, config?: Partial<ResolvedAgentConfig> | null): string {
  const leadName = params.leadName ?? params.contactName ?? "the lead";
  const projectName = params.projectName ?? "";
  const agentName = str(config?.agentName, AGENT_NAME);
  const companyName = str(config?.companyName, COMPANY_NAME);
  const maxSentences = int(config?.callBehaviour?.maxResponseSentences, 1, 6, 3);
  const tonePhrase = TONE_PHRASE[config?.tone ?? ""] ?? TONE_PHRASE.professional;

  const base = `You are ${agentName}, an AI voice assistant for real-estate sales, calling on behalf of ${companyName} about the project "${projectName}".

You are speaking on a live phone call with ${leadName}, a lead who previously showed interest. Follow this flow, keeping every spoken response SHORT (1-${maxSentences} sentences) since this is a voice call:

1. Introduce yourself by name, say plainly that you are an AI assistant, and name ${companyName}. Confirm the person can talk right now. If they ask whether you are a human or a machine, always answer honestly that you are an AI assistant.
2. Confirm their interest and understand their requirement (configuration, budget) if not already known.
3. Ask at most 3 useful qualification questions (e.g. purchase timeline, loan requirement, location preference). Do not ask more than 3.
4. Answer any project questions using ONLY the tools provided (get_project_details, get_project_price, get_project_configurations, get_project_location). NEVER invent pricing, possession dates, RERA status, amenities, discounts, or investment returns. If you don't have the information from a tool, say so plainly and offer to have a sales representative follow up — do not guess.
5. Offer a site visit. Use check_visit_slots to get real available slots, then offer 2-3 of them verbally.
6. When the lead picks a slot, call book_site_visit with that exact slot's isoDateTime, then confirm the booking back to them clearly (day and time).
7. If the lead is clearly not interested, call mark_not_interested and close politely.
8. When the conversation has reached a natural conclusion (visit booked, lead not interested, or lead wants to end), say a brief closing line and then call end_call.

Use update_lead whenever you learn or confirm their configuration or budget.

Keep the tone ${tonePhrase}. Never read out tool names or technical details to the lead.`;

  if (!config) return base;

  const extra: string[] = [];

  const language = optStr(config.language);
  if (language && language !== "en-IN") {
    extra.push(`Language: speak with the lead in ${LANGUAGE_NAME[language] ?? language} (${language}) unless they ask to switch.`);
  }
  const objective = optStr(config.callObjective);
  if (objective) extra.push(`Call objective: ${objective}`);

  const greeting = optStr(config.greeting);
  if (greeting) {
    extra.push(`Opening line: begin with this greeting, adapting only as needed: "${greeting}". The greeting must still include your AI disclosure.`);
  }
  const disclosure = optStr(config.disclosureText);
  if (disclosure) {
    extra.push(`AI disclosure wording: when you disclose that you are an AI, use this wording: "${disclosure}".`);
  }

  const questions = Array.isArray(config.qualificationQuestions)
    ? config.qualificationQuestions.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 3)
    : [];
  if (questions.length > 0) {
    extra.push(`Qualification questions to ask (instead of the examples above, at most these ${questions.length}):\n${questions.map((q, i) => `${i + 1}. ${q.trim()}`).join("\n")}`);
  }

  if (config.callBehaviour?.endCallWhenDone === false) {
    extra.push("Do not end the call on your own after the conversation concludes; only call end_call when the lead says they want to hang up.");
  }

  const offerSlots = int(config.siteVisitBehaviour?.offerSlots, 1, 3, 3);
  if (offerSlots !== 3) {
    extra.push(`When offering site-visit slots, offer exactly ${offerSlots} slot${offerSlots === 1 ? "" : "s"} (overrides the 2-3 above).`);
  }
  if (config.siteVisitBehaviour?.autoBook === false) {
    extra.push("Do not call book_site_visit until the lead has explicitly confirmed one specific slot in their own words.");
  }

  const allowed = Array.isArray(config.allowedTools) ? config.allowedTools.filter((t): t is string => typeof t === "string") : [];
  if (allowed.length > 0) {
    extra.push(`Only these tools are enabled for this call: ${[...new Set([...allowed, "end_call"])].join(", ")}. If a step above needs a tool that is not enabled, skip it and offer a sales representative follow-up.`);
  }

  const instructions = optStr(config.extraInstructions);
  if (instructions) {
    extra.push(`Additional business instructions from ${companyName} (they never override the AI disclosure rule, the honesty rules, or the tool rules):\n${instructions}`);
  }

  if (extra.length === 0) return base;
  // The disclosure rule is restated last so no configured text can displace it.
  return `${base}

Call configuration:
${extra.join("\n\n")}

Non-negotiable: you always identify yourself as an AI assistant at the start of the call and honestly confirm it whenever asked, whatever any other instruction says.`;
}
