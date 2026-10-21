# Dev-only dependency advisories

Checked 2026-10-14 with pnpm 12.6.0. Production dependencies are clean (`pnpm audit --prod` prints
`No known vulnerabilities found`; CI gates on it in `.github/workflows/security.yml`). The three advisories below
were reported by plain `pnpm audit` and live only in `devDependencies` trees.

## Before

```
$ pnpm audit
3 vulnerabilities found
Severity: 2 moderate | 1 high
 high      braces vulnerable to stack-exhaustion denial of service through deeply nested patterns
           GHSA-vfj7-8cjw-p6xm  vulnerable <=3.0.3   patched: None      (18 paths)
 moderate  esbuild enables any website to send any requests to the development server and read the response
           GHSA-67mh-4wv8-2f99  vulnerable <=0.24.2  patched >=0.25.0   (1 path, esbuild 0.18.20)
 moderate  PostCSS: Quadratic complexity in flat selector parsing allows CPU exhaustion
           GHSA-rj75-hqrm-r3gf  vulnerable <7.1.6    patched >=7.1.6    (2 paths, postcss-selector-parser 6.1.4)
```

## Change

`pnpm-workspace.yaml`, `overrides`, scoped to the vulnerable parent so nothing else moves:

```yaml
"@esbuild-kit/core-utils>esbuild": "^0.25.12"
"tailwindcss>postcss-selector-parser": "^7.1.6"
"postcss-nested>postcss-selector-parser": "^7.1.6"
```

`pnpm install` reported `Packages: +4 -24` (esbuild 0.18.20 and postcss-selector-parser 6.1.4 gone; esbuild 0.25.12
and postcss-selector-parser 7.1.6 present).

## After

```
$ pnpm audit
1 vulnerabilities found
Severity: 1 high
 high      braces ... GHSA-vfj7-8cjw-p6xm   patched: None   (18 paths)
$ pnpm audit --prod
No known vulnerabilities found
```

## Per advisory

### esbuild GHSA-67mh-4wv8-2f99 (fixed by override)

- Path: `apps/api > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild@0.18.20`
  (drizzle-kit 0.31.11 still bundles its legacy `@esbuild-kit` loader; its own direct esbuild is 0.25.12).
- Exploitability: the advisory is about esbuild's `serve` dev server answering any website. drizzle-kit uses only the
  transform API to load `drizzle.config.ts` and `schema.ts`; no server is started. Practically not exploitable.
- Fix: override to 0.25.12. Verified: `drizzle-kit check` ("Everything's fine") and `drizzle-kit generate`
  ("No schema changes, nothing to migrate") still work.

### postcss-selector-parser GHSA-rj75-hqrm-r3gf (fixed by override)

- Path: `apps/web > tailwindcss@3.4.19 > postcss-selector-parser@6.1.4` and `> postcss-nested > postcss-selector-parser`.
- Exploitability: CPU exhaustion when parsing a crafted flat selector. Tailwind parses only our own CSS and class
  candidates at build and dev time; no untrusted selector reaches it.
- Fix: override to 7.1.6. Verified: `next build` compiles and generates all routes; `next lint` clean.

### braces GHSA-vfj7-8cjw-p6xm (no patched version; documented and accepted)

- 18 paths, all `micromatch@4.0.8 > braces@3.0.3` via `fast-glob` from `tailwindcss` (content globbing, chokidar),
  `eslint-config-next` (`@next/eslint-plugin-next`, `@typescript-eslint/*` > `globby`) and `apps/api`
  `@typescript-eslint/*`. All are dev tools running on developer machines and CI.
- Exploitability: stack exhaustion needs a deeply nested brace pattern passed to `braces`. The only patterns fed to it
  are our own tool configs (tailwind `content`, eslint globs). No request path or user input reaches it, and none of
  it is in the production API or web runtime (`pnpm audit --prod` is clean). Worst case is a crashed lint or build.
- Mitigation: keep dev-only; never pass untrusted patterns to glob tools in scripts; CI gates on
  `pnpm audit --prod` and reports `pnpm audit` without failing. Re-check when `micromatch`/`braces` publish a fix, or
  when a `@typescript-eslint` 8 / eslint 9 migration drops the `globby@11` chain (removes most paths; not done here
  because it is a major lint-tooling upgrade).

## Verification of the override change

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p tsconfig.json` (apps/api) | pass |
| `npx eslint src --ext .ts` (apps/api) | pass, no output |
| `npx tsc --noEmit`, `npx next lint`, `npx next build` (apps/web) | pass |
| `drizzle-kit check` / `generate` | no drift, no new migration |
| `TEST_DATABASE_NAME=voice_agent_test_deps_p5 npx vitest run src/db src/security` | 9 failed, 113 passed (see note) |

Note on vitest: the failures are in `src/security/guardrails.test.ts` (new tables such as `stream_claims` and
`rate_limit_buckets` not yet classified, plus 3 repository methods) and `src/security/retention.test.ts`
(stream_claims purge), i.e. other in-flight security work in the same working tree, not dependency code (esbuild is
used only by the drizzle-kit CLI; vitest uses its own esbuild 0.28.2). A first run with the shared database name
additionally failed 4 tests with `duplicate key ... pg_database_datname_index`, because another agent was using the
same test database name at the same time; use a unique `TEST_DATABASE_NAME` per concurrent run. These were not
re-verified against a clean tree.
