import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Test files share one Postgres database; run them serially so cross-file
    // fixtures and counts cannot interleave.
    fileParallelism: false,
  },
});
