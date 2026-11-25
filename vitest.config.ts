import { defineConfig } from 'vitest/config';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = `${root}packages`;

// Resolve @veyract/<name> to packages/<name>/src so tests need no build.
const alias: Record<string, string> = {};
if (existsSync(pkgDir)) {
  for (const name of readdirSync(pkgDir)) {
    alias[`@veyract/${name}`] = `${pkgDir}/${name}/src/index.ts`;
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    include: ['packages/*/test/**/*.test.ts', 'scripts/*.test.mjs'],
  },
});
