/**
 * The composition root for optional modules: the ONE place that decides which modules are plugged into this
 * deployment. The Voice AI core (app.ts, auth, calls, agents, ...) imports nothing from any module; it receives the
 * manifests listed here and registers whatever they contribute (tools, call hooks, prompt templates, permissions,
 * data scopes, HTTP routes).
 *
 * To run the platform without Sales, remove it from this list. To add a module, add its manifest.
 */
import type { ModuleManifest } from "./modules/modules/module-contract.js";
import { salesModule } from "./modules/sales/index.js";

export const CONFIGURED_MODULES: readonly ModuleManifest[] = [salesModule];
