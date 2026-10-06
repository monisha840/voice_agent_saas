import { z } from "zod";
import { isKnownToolName } from "../../ai-tools/index.js";

/** Checked against the live registry at validation time: modules register their tools after this file loads. */
const toolName = z.string().refine(isKnownToolName, { message: "Unknown tool" });
const MAX_TOOLS = 50;
import { DISCLOSURE_PATTERN, SUPPORTED_LANGUAGES, TONES } from "../agent-config/agent-config.validation.js";
import { GENERIC_TEMPLATE_KEY } from "./agents.constants.js";
import { getPromptTemplate } from "../ai-agent/persona.js";
import { getAgentConfigSection, isKnownKnowledgeSourceType } from "./agent-extensions.js";

const behaviour = z
  .object({
    maxResponseSentences: z.number().int().min(1).max(6),
    endCallWhenDone: z.boolean(),
    conversationQuestions: z.array(z.string().trim().min(1).max(200)).max(3),
  })
  .partial()
  .strict();

/** Checked against the registries at validation time: modules register after this file loads. */
const templateKey = z
  .string()
  .refine((k) => k === GENERIC_TEMPLATE_KEY || getPromptTemplate(k) !== undefined, { message: "Unknown prompt template" });

/** Each key must be a section a registered module defined, and its value must satisfy that module's own schema. */
const moduleConfig = z
  .record(z.string(), z.unknown())
  .transform((value, ctx) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, raw] of Object.entries(value)) {
      const section = getAgentConfigSection(key);
      if (!section) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Unknown module settings "${key}"` });
        continue;
      }
      const parsed = section.schema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        continue;
      }
      out[key] = parsed.data;
    }
    return out;
  });

/**
 * Fields of an agent. Strict: unknown keys are rejected, not ignored. `voice` is stored only
 * (null = provider default); it is NOT wired to any telephony/TTS provider yet.
 */
const fields = {
  name: z.string().trim().min(1).max(120),
  personaName: z.string().trim().min(1).max(80),
  companyName: z.string().trim().max(160).nullable(),
  description: z.string().trim().max(2000).nullable(),
  promptTemplateKey: templateKey,
  systemPrompt: z.string().trim().max(8000).nullable(),
  extraInstructions: z.string().trim().max(1500).nullable(),
  callObjective: z.string().trim().max(1000).nullable(),
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
  voice: z.string().trim().min(1).max(80).nullable(),
  tone: z.enum(TONES),
  behaviour,
  enabledTools: z
    .array(toolName)
    .min(1)
    .max(MAX_TOOLS),
  moduleConfig,
};

export const createAgentSchema = z.object(fields).partial().required({ name: true, personaName: true }).strict();

export const updateAgentSchema = z.object(fields).partial().strict();

export const listAgentsQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const agentIdParamsSchema = z.object({ id: z.string().uuid() });

export const replaceKnowledgeSchema = z
  .object({
    bindings: z
      .array(
        z
          .object({
            sourceType: z.string().refine(isKnownKnowledgeSourceType, { message: "Unknown knowledge source type" }),
            sourceId: z.string().uuid(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
