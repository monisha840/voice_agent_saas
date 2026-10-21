/** Constants shared by the agents service, validation and the seed/create-org scripts. */
import { getPromptTemplate } from "../ai-agent/persona.js";

/** "generic" is built in; any other value is the key of a prompt template a module registered. */
export type PromptTemplateKey = string;
export const GENERIC_TEMPLATE_KEY = "generic";

export const AGENT_STATUSES = ["active", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The only tool every agent has: it can always hang up. */
export const END_CALL_TOOL = "end_call";

/** The core knowledge-base source type and the tool that searches it (modules/knowledge). */
export const KNOWLEDGE_BASE_SOURCE = "knowledge_base";
export const SEARCH_KNOWLEDGE_TOOL = "search_knowledge";

/** Tools of the 'generic' template. */
export const GENERIC_TOOL_NAMES: readonly string[] = [END_CALL_TOOL];

export const DEFAULT_BEHAVIOUR = Object.freeze({
  maxResponseSentences: 3,
  endCallWhenDone: true,
  conversationQuestions: [] as string[],
});

/** The tools a new agent gets when none are named: its template's own defaults (a module template), else just end_call. */
export function defaultToolsFor(template: PromptTemplateKey): string[] {
  return [...(getPromptTemplate(template)?.defaultTools ?? GENERIC_TOOL_NAMES)];
}
