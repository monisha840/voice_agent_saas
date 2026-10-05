import { config } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// drizzle-kit loads this file via CJS require, so it can't resolve the
// project's own ESM `env.ts` helper (NodeNext ".js" specifier), and
// `import.meta` is unavailable in that CJS transpilation. Load the root
// .env directly via process.cwd() instead (drizzle-kit always runs with
// cwd = apps/api); src/config/env.ts remains the loader used by the
// actual application code (server, migrate, seed).
config({ path: resolve(process.cwd(), "../../.env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
