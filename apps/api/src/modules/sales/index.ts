import { registerModule } from "../modules/module-runtime.js";
import type { ModuleManifest } from "../modules/module-contract.js";
import { salesCallHooks } from "./sales-call-hooks.js";
import { SALES_TOOLS } from "./tools/index.js";
import { buildSalesRealEstatePrompt } from "./sales-prompt.js";
import { generateSalesSummary, SALES_SUMMARY_PROFILE } from "./sales-summary.js";
import { agentSalesConfig, salesAgentConfigSection, salesProjectKnowledgeSource } from "./sales-agent-config.js";
import { SALES_MODULE_KEY, SALES_PROMPT_TEMPLATE_KEY, SALES_TOOL_NAMES } from "./sales-constants.js";
import { ALL_TOOL_NAMES } from "../../ai-tools/index.js";
import { SALES_PERMISSIONS } from "./sales-permissions.js";
import { salesScopeProvider } from "./sales-scope.js";
import { salesRoutes } from "./sales-routes.js";

/**
 * Everything the Sales module contributes to the Voice AI core, in one place. The core never imports any of
 * this; it sees only what registerModule puts into its registries.
 */
export const salesModule: ModuleManifest = {
  key: SALES_MODULE_KEY,
  tools: SALES_TOOLS,
  callHooks: salesCallHooks,
  promptTemplates: [
    {
      key: SALES_PROMPT_TEMPLATE_KEY,
      moduleKey: SALES_MODULE_KEY,
      defaultTools: SALES_TOOL_NAMES,
      build: buildSalesRealEstatePrompt,
      // An agent config with no template key is the original real-estate agent.
      legacyDefault: true,
      summaryProfile: SALES_SUMMARY_PROFILE,
      configureRuntime({ agent, effectiveTools, config }) {
        const sales = agentSalesConfig(agent);
        return {
          ...config,
          siteVisitBehaviour: { offerSlots: sales?.offerSlots ?? 3, autoBook: sales?.autoBook ?? true },
          // The real-estate prompt only mentions "enabled tools" when a restriction exists. An agent that exposes every
          // registered tool passes the "no restriction" prompt value, which keeps the prompt byte-identical. This is the
          // PROMPT's input only: the tools actually offered come from config.effectiveTools, which is always explicit.
          allowedTools: effectiveToolsAreAll(effectiveTools) ? [] : [...effectiveTools],
        };
      },
    },
  ],
  agentConfigSections: [salesAgentConfigSection],
  knowledgeSources: [salesProjectKnowledgeSource],
  summaryProfiles: [{ key: SALES_SUMMARY_PROFILE, legacyDefault: true, generate: generateSalesSummary }],
  // What the core's permission matrix, data scoping and HTTP surface learn about Sales from this manifest (and nowhere else).
  permissions: SALES_PERMISSIONS,
  scopeProvider: salesScopeProvider,
  routes: salesRoutes,
};

function effectiveToolsAreAll(effective: readonly string[]): boolean {
  return effective.length === ALL_TOOL_NAMES.length;
}

/** Plug the Sales module into the core. Idempotent; called at startup (app.ts) and by the test setup. */
export function registerSalesModule(): void {
  registerModule(salesModule);
}
