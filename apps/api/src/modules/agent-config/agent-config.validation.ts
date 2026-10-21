import { z } from "zod";
import { isKnownToolName } from "../../ai-tools/index.js";

/** Checked against the live registry at validation time: modules register their tools after this file loads. */
const toolName = z.string().refine(isKnownToolName, { message: "Unknown tool" });
const MAX_TOOLS = 50;

/**
 * The languages an agent can be CONFIGURED in: the two this product actually supports and sells.
 *
 * "Tanglish" is not a third code. Tamil-English code-mixing is how `ta-IN` behaves, because the speech provider runs
 * in code-mix mode (SARVAM_STT_MODE / SARVAM_STT_REALTIME_MODE default to "codemix"), so a Tamil agent already
 * understands and answers a caller who drops English words into Tamil.
 *
 * Nothing else belongs here until it has been validated end to end over the 8 kHz phone path. In particular Hindi
 * (hi-IN) is NOT supported: offering it would be advertising a capability nobody has checked.
 *
 * Rows written while a wider list was offered keep their stored value in the database (there is no migration that
 * rewrites them); the read path coerces an unknown code to en-IN, see `agent-config.service.ts` and `agents.service.ts`.
 * Separately, the ai-agent RUNTIME still recognises and can answer in languages that are not on this list (see
 * `ai-agent/caller-input.ts` and `ai-agent/fallback-lines.ts`): handling an unexpected caller gracefully is not the
 * same thing as selling the language, and that code must not be narrowed to match this list.
 */
export const SUPPORTED_LANGUAGES = ["en-IN", "ta-IN"] as const;
export const TONES = ["professional", "friendly", "warm", "formal", "energetic"] as const;

/**
 * The AI disclosure is mandatory and has no on/off flag. A custom wording must
 * still clearly say the agent is an AI / automated / virtual assistant.
 */
export const DISCLOSURE_PATTERN = /\b(ai|a\.i\.|artificial|automated|virtual assistant|bot)\b/i;

const callBehaviour = z
  .object({
    maxResponseSentences: z.number().int().min(1).max(6).default(3),
    endCallWhenDone: z.boolean().default(true),
  })
  .strict();

const siteVisitBehaviour = z
  .object({
    offerSlots: z.number().int().min(1).max(3).default(3),
    autoBook: z.boolean().default(true),
  })
  .strict();

const uuid = z.string().uuid();

/** Strict: unknown keys (e.g. a hypothetical "disclosureEnabled") are rejected, not ignored. */
export const agentConfigFieldsSchema = z
  .object({
    agentName: z.string().trim().min(1).max(80),
    companyName: z.string().trim().max(160).nullable(),
    greeting: z.string().trim().max(500).nullable(),
    disclosureText: z
      .string()
      .trim()
      .max(300)
      .refine((v) => DISCLOSURE_PATTERN.test(v), {
        message: "must clearly state that the agent is an AI, automated or virtual assistant (the AI disclosure is mandatory)",
      })
      .nullable(),
    language: z.enum(SUPPORTED_LANGUAGES),
    tone: z.enum(TONES),
    callObjective: z.string().trim().max(1000).nullable(),
    qualificationQuestions: z.array(z.string().trim().min(1).max(200)).max(3),
    callBehaviour,
    allowedTools: z.array(toolName).max(MAX_TOOLS),
    siteVisitBehaviour,
    extraInstructions: z.string().trim().max(1500).nullable(),
  })
  .partial()
  .strict();

export const upsertAgentConfigSchema = agentConfigFieldsSchema.extend({ projectId: uuid.optional() }).strict();

export const agentConfigQuerySchema = z.object({ projectId: uuid.optional() });

export type AgentConfigFields = z.infer<typeof agentConfigFieldsSchema>;
