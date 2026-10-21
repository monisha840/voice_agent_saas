/**
 * Post-call summarization: runs one extra LLM call over the full
 * transcript to produce a structured qualification JSON object and a
 * short human-readable summary, per MVP_IMPLEMENTATION_PLAN.md §7 /
 * the Phase 6 requirements.
 */

import type { ILanguageModel } from "../../adapters/ai/llm.interface.js";
import type { TranscriptTurn } from "../../db/repositories/conversations.repository.js";
import { logger } from "../../shared/logger.js";
import type { SummaryProfileDef } from "../modules/module-contract.js";

export const SUMMARY_TOOL_NAME = "emit_call_summary";

/** "generic" is built in; any other value is the key of a profile a module registered. */
export type SummaryProfile = string;

/** Stable marker line in the generic prompt; the mock LLM keys off it. */
export const GENERIC_SUMMARY_MARKER = "SUMMARY_PROFILE: generic";

export interface GenericSummaryData {
  profile: "generic";
  summary: string;
  outcome: "resolved" | "follow_up_needed" | "no_resolution" | "unknown";
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  keyPoints: string[];
  recommendedNextAction: string;
  contact: { name: string | null; phone: string | null; email: string | null };
  extracted: Record<string, string>;
}

/** A stored call summary: the generic shape, or whatever shape a module's profile produces. */
export type CallSummary = GenericSummaryData | Record<string, unknown>;

export function isGenericSummary(x: unknown): x is GenericSummaryData {
  return typeof x === "object" && x !== null && (x as { profile?: unknown }).profile === "generic";
}

const GENERIC_OUTCOMES = ["resolved", "follow_up_needed", "no_resolution", "unknown"] as const;
const GENERIC_SENTIMENTS = ["positive", "neutral", "negative", "unknown"] as const;
const MAX_EXTRACTED_KEYS = 20;
const MAX_KEY_POINTS = 20;
const MAX_TEXT = 2000;
const MAX_SHORT = 200;

function buildGenericSummaryPrompt(transcript: TranscriptTurn[]): string {
  const transcriptText = transcript.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  return `${GENERIC_SUMMARY_MARKER}
Below is the full transcript of a phone call between an AI voice assistant and a caller. Analyze it and call the ${SUMMARY_TOOL_NAME} tool with a structured summary. Base every field only on what was actually said — do not invent details. Omit any field that was not discussed.

TRANSCRIPT:
${transcriptText}`;
}

function genericSummaryToolDefinition() {
  return {
    name: SUMMARY_TOOL_NAME,
    description: "Emit a structured summary of the completed call.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string", enum: [...GENERIC_OUTCOMES] },
        sentiment: { type: "string", enum: [...GENERIC_SENTIMENTS] },
        keyPoints: { type: "array", items: { type: "string" } },
        recommendedNextAction: { type: "string" },
        contact: {
          type: "object",
          properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" } },
        },
        extracted: {
          type: "object",
          description: "Other facts stated on the call, as short string key/value pairs.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["summary", "outcome", "sentiment"],
    },
  };
}

function fallbackGeneric(reason: string): GenericSummaryData {
  return {
    profile: "generic",
    summary: `Summary unavailable (${reason}). See raw transcript.`,
    outcome: "unknown",
    sentiment: "unknown",
    keyPoints: [],
    recommendedNextAction: "Manual review required",
    contact: { name: null, phone: null, email: null },
    extracted: {},
  };
}

function cap(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function normalizeGenericSummary(args: unknown): GenericSummaryData {
  const a = asRecord(args);
  const base = fallbackGeneric("partial data");
  const contactRaw = asRecord(a.contact);
  const extracted: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(a.extracted))) {
    if (Object.keys(extracted).length >= MAX_EXTRACTED_KEYS) break;
    const key = k.trim().slice(0, 60);
    const val = cap(v, MAX_SHORT * 2);
    if (!key || key === "__proto__" || val === null) continue;
    extracted[key] = val;
  }
  return {
    profile: "generic",
    summary: cap(a.summary, MAX_TEXT) ?? base.summary,
    outcome: isOneOf(a.outcome, GENERIC_OUTCOMES) ? a.outcome : "unknown",
    sentiment: isOneOf(a.sentiment, GENERIC_SENTIMENTS) ? a.sentiment : "unknown",
    keyPoints: Array.isArray(a.keyPoints)
      ? a.keyPoints
          .map((p) => cap(p, MAX_SHORT * 2))
          .filter((p): p is string => p !== null)
          .slice(0, MAX_KEY_POINTS)
      : [],
    recommendedNextAction: cap(a.recommendedNextAction, MAX_SHORT * 2) ?? base.recommendedNextAction,
    contact: {
      name: cap(contactRaw.name, MAX_SHORT),
      phone: cap(contactRaw.phone, MAX_SHORT),
      email: cap(contactRaw.email, MAX_SHORT),
    },
    extracted,
  };
}

async function generateGenericSummary(llm: ILanguageModel, transcript: TranscriptTurn[]): Promise<GenericSummaryData> {
  if (transcript.length === 0) return fallbackGeneric("empty transcript");
  try {
    const result = await llm.chat(
      [{ role: "user", content: buildGenericSummaryPrompt(transcript) }],
      [genericSummaryToolDefinition()],
    );
    const call = result.toolCalls?.[0];
    if (!call) {
      return {
        ...fallbackGeneric("model did not return structured output"),
        summary: result.content?.slice(0, 500) || fallbackGeneric("empty response").summary,
      };
    }
    return normalizeGenericSummary(call.arguments);
  } catch (err) {
    logger.error("post-call-summary: generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallbackGeneric("summary generation failed");
  }
}

const profiles = new Map<string, SummaryProfileDef>();

export function registerSummaryProfile(def: SummaryProfileDef): void {
  profiles.set(def.key, def);
}

export function unregisterSummaryProfile(key: string): void {
  profiles.delete(key);
}

/** The profile a call with no usable agent template gets (the pre-agents behaviour), if a module claims it; else "generic". */
export function legacyDefaultSummaryProfile(): SummaryProfile {
  return [...profiles.values()].find((p) => p.legacyDefault)?.key ?? "generic";
}

/** A profile key nobody registered falls back to generic, so a call is always summarised. */
export function generateCallSummary(llm: ILanguageModel, transcript: TranscriptTurn[], profile: "generic"): Promise<GenericSummaryData>;
export function generateCallSummary(llm: ILanguageModel, transcript: TranscriptTurn[], profile?: SummaryProfile): Promise<CallSummary>;
export async function generateCallSummary(
  llm: ILanguageModel,
  transcript: TranscriptTurn[],
  profile: SummaryProfile = legacyDefaultSummaryProfile(),
): Promise<CallSummary> {
  const def = profile === "generic" ? undefined : profiles.get(profile);
  if (!def) return generateGenericSummary(llm, transcript);
  return (await def.generate(llm, transcript)) as CallSummary;
}

export function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}
