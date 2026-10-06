/**
 * Dependency direction: the Voice AI core must not import Sales code. These directories are the core's call, tool,
 * prompt, summary and module-registry machinery; none of their (non-test) files may import the Sales module or the
 * Sales-owned feature folders. The Sales module imports the core, never the reverse.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIRS = ["ai-tools", "modules/calls", "modules/ai-agent", "modules/modules", "modules/agents"];
const FORBIDDEN = /\/(sales|leads|projects|site-visits)\//;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(dir, e.name));
}

describe("core does not depend on the Sales module", () => {
  for (const dir of CORE_DIRS) {
    for (const file of sourceFiles(dir)) {
      it(`${file} imports nothing from sales, leads, projects or site-visits`, () => {
        const text = readFileSync(join(SRC, file), "utf8");
        const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
        expect(imports.filter((spec) => FORBIDDEN.test(spec))).toEqual([]);
      });
    }
  }
});
