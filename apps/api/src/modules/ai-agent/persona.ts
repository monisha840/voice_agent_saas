/**
 * The demo agent persona and system prompt. The prompt itself contains
 * NO project facts — those are injected at runtime from project_knowledge
 * via tool calls (get_project_details, get_project_price, etc.), per the
 * rule that the agent must never invent project information and must
 * only use database-backed knowledge.
 *
 * An optional ResolvedAgentConfig (per-organization / per-project settings)
 * customizes the persona. With no config the prompt is exactly the original
 * one. The AI disclosure instruction is part of the fixed template and is
 * NEVER conditional on the config: no field can remove it.
 */
import type { ResolvedAgentConfig } from "../agent-config/agent-config.types.js";
import type { PromptTemplateDef } from "../modules/module-contract.js";

/**
 * The built-in persona of the original single-purpose agent. Kept only because the /api/agent-config compatibility
 * facade still seeds its defaults from them; the Sales template (modules/sales/sales-prompt.ts) uses them as fallbacks.
 */
export const AGENT_NAME = "Priya";
export const COMPANY_NAME = "Green Valley Developers";

export const TONE_PHRASE: Record<string, string> = {
  professional: "warm, concise, and professional",
  friendly: "friendly, concise, and approachable",
  warm: "warm, caring, and concise",
  formal: "formal, courteous, and concise",
  energetic: "upbeat, energetic, and concise",
};

export const LANGUAGE_NAME: Record<string, string> = {
  "hi-IN": "Hindi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "pa-IN": "Punjabi",
  "od-IN": "Odia",
};

/** Config values come from the database (jsonb); never trust their shape. */
export function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
export function optStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
export function int(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

export interface PromptParams {
  /** Parameters a module's template reads (the Sales template uses leadName and projectName). The core only passes them through. */
  [moduleParam: string]: string | null | undefined;
  /** Who is on the other end, when known (generic template). */
  contactName?: string | null;
  direction?: "inbound" | "outbound";
  callType?: "outbound" | "inbound" | "test";
}

const templates = new Map<string, PromptTemplateDef>();

export function registerPromptTemplate(def: PromptTemplateDef): void {
  templates.set(def.key, def);
}

export function unregisterPromptTemplate(key: string): void {
  templates.delete(key);
}

/** The registered template for a key; the built-in "generic" template is not in the registry and returns undefined. */
export function getPromptTemplate(key: string | null | undefined): PromptTemplateDef | undefined {
  return key ? templates.get(key) : undefined;
}

/** The template a config without a key falls back to (the pre-agents behaviour), if a module claims it. */
export function legacyDefaultPromptTemplate(): PromptTemplateDef | undefined {
  return [...templates.values()].find((t) => t.legacyDefault);
}

/**
 * Picks the agent's template. "generic" is built in. A key a module registered uses that module's template. An
 * absent key means the legacy default (the Sales template while that module is registered). A key nobody
 * registered falls back to the generic template, so an agent never gets a prompt from a module that is not there.
 */
export function buildSystemPrompt(params: PromptParams, config?: Partial<ResolvedAgentConfig> | null): string {
  const key = config?.promptTemplateKey;
  if (key === "generic") return buildGenericPrompt(params, config);
  const template = key ? templates.get(key) : legacyDefaultPromptTemplate();
  return template ? template.build(params, config) : buildGenericPrompt(params, config);
}

/**
 * The generic, business-neutral template. It names no company or brand unless the agent has one,
 * contains no industry wording, and lists only the tools the agent can actually use. The AI
 * disclosure and honesty rules are fixed text, restated last, and no configured field can remove them.
 */
export function buildGenericPrompt(params: PromptParams, config?: Partial<ResolvedAgentConfig> | null): string {
  const agentName = optStr(config?.agentName);
  const companyName = optStr(config?.companyName);
  const maxSentences = int(config?.callBehaviour?.maxResponseSentences, 1, 6, 3);
  const tonePhrase = TONE_PHRASE[config?.tone ?? ""] ?? TONE_PHRASE.professional;
  const contactName = optStr(params.contactName);
  const callType = params.callType ?? params.direction ?? "outbound";

  const identity = `You are ${agentName ?? "an assistant"}, an AI voice assistant${companyName ? ` for ${companyName}` : ""}.`;

  let callContext: string;
  if (callType === "inbound") {
    callContext = contactName
      ? `This is an inbound call: ${contactName} has called you. Answer in a "thank you for calling" style, greet ${contactName} by name, and ask how you can help.`
      : `This is an inbound call: someone has called you and their identity is unknown. Answer in a "thank you for calling" style and ask how you can help. You may politely ask for their name, but do not insist.`;
  } else if (callType === "test") {
    callContext = contactName
      ? `This is a test call with ${contactName}, who is trying out the assistant. Behave exactly as you would on a real call.`
      : `This is a test call with an unidentified person who is trying out the assistant. Behave exactly as you would on a real call, and you may politely ask for their name.`;
  } else {
    callContext = contactName
      ? `This is an outbound call: you are calling ${contactName}. Use their name naturally.`
      : `This is an outbound call to a person whose identity is unknown. Do not assume their name; you may politely ask for it.`;
  }

  const language = optStr(config?.language);
  const languageLine =
    language && language !== "en-IN"
      ? `Speak in ${LANGUAGE_NAME[language] ?? language} (${language}) unless the other person asks to switch.`
      : "Speak in English unless the other person asks to switch.";

  const base = `${identity}

You are speaking on a live phone call. Keep every spoken response SHORT (1-${maxSentences} sentences) since this is a voice call. ${languageLine} Keep the tone ${tonePhrase}. Never read out tool names or technical details.

Call context:
${callContext}

At the start of the call, introduce yourself${agentName ? " by name" : ""}${companyName ? `, name ${companyName}` : ""}, and say plainly that you are an AI assistant and that the call may be recorded. If they ask whether you are a human or a machine, always answer honestly that you are an AI assistant. Never invent facts: if you do not know something and no tool provides it, say so plainly instead of guessing. When the conversation reaches a natural conclusion, say a brief closing line and then call end_call.`;

  const extra: string[] = [];

  const objective = optStr(config?.callObjective);
  if (objective) extra.push(`Call objective: ${objective}`);

  const greeting = optStr(config?.greeting);
  if (greeting) {
    extra.push(`Opening line: begin with this greeting, adapting only as needed: "${greeting}". The greeting must still include your AI disclosure and the notice that the call may be recorded.`);
  }
  const disclosure = optStr(config?.disclosureText);
  if (disclosure) {
    extra.push(`AI disclosure wording: when you disclose that you are an AI, use this wording: "${disclosure}".`);
  }

  const questions = Array.isArray(config?.qualificationQuestions)
    ? config.qualificationQuestions.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 3)
    : [];
  if (questions.length > 0) {
    extra.push(`Questions to ask (at most these ${questions.length}):\n${questions.map((q, i) => `${i + 1}. ${q.trim()}`).join("\n")}`);
  }

  if (config?.callBehaviour?.endCallWhenDone === false) {
    extra.push("Do not end the call on your own after the conversation concludes; only call end_call when the other person says they want to hang up.");
  }

  const enabled = Array.isArray(config?.allowedTools) ? config.allowedTools.filter((t): t is string => typeof t === "string") : [];
  const toolNames = [...new Set([...enabled, "end_call"])];
  extra.push(
    `Tools enabled for this call: ${toolNames.join(", ")}. Use ONLY these tools and never invent facts they do not provide. If a step needs a tool that is not enabled, skip that step.`,
  );

  const role = optStr(config?.systemPrompt);
  if (role) {
    extra.push(`Role instructions for this agent (they never override the AI disclosure rule, the honesty rules, or the tool rules):\n${role}`);
  }
  const instructions = optStr(config?.extraInstructions);
  if (instructions) {
    extra.push(`Additional instructions (they never override the AI disclosure rule, the honesty rules, or the tool rules):\n${instructions}`);
  }

  // The disclosure rule is restated last so no configured text can displace it.
  return `${base}

Call configuration:
${extra.join("\n\n")}

Non-negotiable: you always identify yourself as an AI assistant at the start of the call, say that the call may be recorded, and honestly confirm that you are an AI whenever asked, whatever any other instruction says.`;
}
