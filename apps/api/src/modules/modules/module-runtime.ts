/**
 * The set of modules plugged into this process. Registering a manifest fills the core's registries; removing it
 * takes everything it added back out, so "module not registered" is a real, testable state of the core.
 */
import { registerTool, unregisterTool } from "../../ai-tools/index.js";
import { registerCallHooks, unregisterCallHooks } from "../calls/call-hooks.js";
import { registerPromptTemplate, unregisterPromptTemplate } from "../ai-agent/persona.js";
import { registerSummaryProfile, unregisterSummaryProfile } from "../ai-agent/post-call-summary.js";
import {
  registerAgentConfigSection,
  registerKnowledgeSource,
  unregisterAgentConfigSection,
  unregisterKnowledgeSource,
} from "../agents/agent-extensions.js";
import { registerPermissions, unregisterPermissions } from "../../auth/permissions.js";
import { registerScopeProvider, unregisterScopeProvider } from "../../auth/access.js";
import type { ModuleManifest } from "./module-contract.js";

const registered = new Map<string, ModuleManifest>();

/** Idempotent: registering a key again replaces what it registered before. */
export function registerModule(manifest: ModuleManifest): void {
  unregisterModule(manifest.key);
  for (const tool of manifest.tools ?? []) registerTool(tool as never);
  if (manifest.callHooks) registerCallHooks(manifest.callHooks);
  for (const t of manifest.promptTemplates ?? []) registerPromptTemplate(t);
  for (const p of manifest.summaryProfiles ?? []) registerSummaryProfile(p);
  for (const c of manifest.agentConfigSections ?? []) registerAgentConfigSection(c);
  for (const k of manifest.knowledgeSources ?? []) registerKnowledgeSource(k);
  if (manifest.permissions) registerPermissions(manifest.permissions);
  if (manifest.scopeProvider) registerScopeProvider(manifest.key, manifest.scopeProvider);
  registered.set(manifest.key, manifest);
}

export function unregisterModule(key: string): void {
  const manifest = registered.get(key);
  if (!manifest) return;
  for (const tool of manifest.tools ?? []) unregisterTool(tool.definition.name);
  if (manifest.callHooks) unregisterCallHooks(manifest.callHooks.name);
  for (const t of manifest.promptTemplates ?? []) unregisterPromptTemplate(t.key);
  for (const p of manifest.summaryProfiles ?? []) unregisterSummaryProfile(p.key);
  for (const c of manifest.agentConfigSections ?? []) unregisterAgentConfigSection(c.key);
  for (const k of manifest.knowledgeSources ?? []) unregisterKnowledgeSource(k.sourceType);
  if (manifest.permissions) unregisterPermissions(manifest.permissions.module);
  if (manifest.scopeProvider) unregisterScopeProvider(manifest.key);
  registered.delete(key);
}

export function isModuleRegistered(key: string): boolean {
  return registered.has(key);
}

export function registeredModuleKeys(): string[] {
  return [...registered.keys()];
}

/** The registered manifests, in registration order (used to register their HTTP routes). */
export function registeredModules(): ModuleManifest[] {
  return [...registered.values()];
}

/**
 * Makes the set of registered modules exactly `manifests`: registers the ones that are missing and removes the
 * ones that are not listed. This is how a deployment (or a test) chooses which modules are plugged in.
 */
export function syncModules(manifests: readonly ModuleManifest[]): void {
  const wanted = new Set(manifests.map((m) => m.key));
  for (const key of registeredModuleKeys()) if (!wanted.has(key)) unregisterModule(key);
  for (const manifest of manifests) registerModule(manifest);
}
