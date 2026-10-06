/** The effective, fully-populated agent configuration used for a call and shown in the UI. */
export interface ResolvedAgentConfig {
  agentName: string;
  /** Null = no company (the generic prompt then names none; the legacy sales template falls back to its built-in company). */
  companyName: string | null;
  greeting: string | null;
  /** Wording of the mandatory AI disclosure. Null = built-in wording. The disclosure itself can never be turned off. */
  disclosureText: string | null;
  language: string;
  tone: string;
  callObjective: string | null;
  qualificationQuestions: string[];
  callBehaviour: { maxResponseSentences: number; endCallWhenDone: boolean };
  /** Legacy field; feeds the prompt's tool wording only. For a stored configuration, empty means unrestricted. */
  allowedTools: string[];
  /**
   * The tools a live call really offers and executes, set by the call runtime. When present it is an explicit
   * allow-list (an empty one means only end_call, never "all tools") and it overrides allowedTools for tool access.
   */
  effectiveTools?: string[];
  siteVisitBehaviour: { offerSlots: number; autoBook: boolean };
  extraInstructions: string | null;
  /** Which prompt template the agent uses. Absent = the legacy "sales_real_estate" behaviour. */
  promptTemplateKey?: PromptTemplateKey;
  /** The agent's own role instructions (generic template). */
  systemPrompt?: string | null;
  /** Stored only; not used by the call pipeline yet. */
  voice?: string | null;
}

export type PromptTemplateKey = "generic" | "sales_real_estate";

export type AgentConfigSource = "project" | "organization" | "default";
