/**
 * The catalogue of optional feature packs. The Voice AI core (agents, calls,
 * test, usage, team, settings) is always on and is not a module. A module is
 * available to an organization only if organization_modules has an enabled
 * row for it (a missing row means disabled).
 *
 * In Phase 1 this is metadata plus a gate; Phase 3 moves the sales routes,
 * tools and permissions behind it.
 */
export interface ModuleDefinition {
  key: string;
  label: string;
  description: string;
}

export const MODULES = [
  {
    key: "sales",
    label: "Sales",
    description: "Leads, projects, site visits and real-estate knowledge for outbound sales calls.",
  },
] as const satisfies readonly ModuleDefinition[];

export type ModuleKey = (typeof MODULES)[number]["key"];

export const MODULE_KEYS: readonly ModuleKey[] = MODULES.map((m) => m.key);

/** Modules a newly created organization gets until Phase 3 changes the default. */
export const DEFAULT_NEW_ORG_MODULES: readonly ModuleKey[] = ["sales"];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

export function getModule(key: ModuleKey): ModuleDefinition {
  return MODULES.find((m) => m.key === key)!;
}
