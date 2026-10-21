import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Test files share one Postgres database; run them serially so cross-file
    // fixtures and counts cannot interleave. (This also forces maxWorkers to 1.)
    fileParallelism: false,
    /**
     * Isolation (a fresh worker per file) is REQUIRED and must not be turned off.
     *
     * Tried and reverted 2026-10-21: `isolate: false` (the Vitest 4 replacement for the removed
     * `poolOptions.forks.singleFork`) does stop the intermittent worker crash and makes the counts reconcile, but it
     * fails 17 tests across 11 files. The suite legitimately depends on per-file isolation: the optional-module
     * registries (`modules/modules/module-runtime.ts`, `auth/permissions.ts` registerPermissions/unregisterPermissions)
     * and the provider singletons (`adapters/ai|email|telephony/index.ts`) are module-level state, so with a shared
     * worker the Sales module stays registered into files that assert it is absent, tool catalogues accumulate, and
     * a spy TTS provider outlives the file that installed it.
     *
     * Making isolation optional would mean teardown in every file that registers a module or swaps a provider --
     * a real refactor, not a config flag.
     */
  },
});
