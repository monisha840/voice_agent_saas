/**
 * What modules add to agents, kept in registries so the agents service and validation stay generic: settings
 * sections inside an agent's moduleConfig, and the kinds of knowledge an agent can be bound to. Modules fill them
 * through registerModule (modules/modules/module-runtime.ts); with nothing registered an agent has no module
 * settings and no knowledge sources.
 */
import type { AgentConfigSectionDef, KnowledgeSourceDef } from "../modules/module-contract.js";

const sections = new Map<string, AgentConfigSectionDef>();
const sources = new Map<string, KnowledgeSourceDef>();

export function registerAgentConfigSection(def: AgentConfigSectionDef): void {
  sections.set(def.key, def);
}
export function unregisterAgentConfigSection(key: string): void {
  sections.delete(key);
}
export function getAgentConfigSection(key: string): AgentConfigSectionDef | undefined {
  return sections.get(key);
}

export function registerKnowledgeSource(def: KnowledgeSourceDef): void {
  sources.set(def.sourceType, def);
}
export function unregisterKnowledgeSource(sourceType: string): void {
  sources.delete(sourceType);
}
export function getKnowledgeSource(sourceType: string): KnowledgeSourceDef | undefined {
  return sources.get(sourceType);
}
export function isKnownKnowledgeSourceType(sourceType: string): boolean {
  return sources.has(sourceType);
}

/** A stored moduleConfig as the API shows it: only sections whose module is registered, each normalised. */
export function normalizeModuleConfig(raw: unknown): Record<string, Record<string, unknown>> {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, def] of sections) {
    const section = def.normalize(stored[key]);
    if (section) out[key] = section;
  }
  return out;
}

/** The moduleConfig to store after applying a request's sections on top of what is stored. Unrelated stored keys are kept. */
export function mergeModuleConfig(
  stored: unknown,
  patch: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const existing = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, section] of Object.entries(patch ?? {})) {
    const def = sections.get(key);
    if (!def) continue;
    merged[key] = { ...def.defaults, ...(def.normalize(existing[key]) ?? {}), ...section };
  }
  return merged;
}
