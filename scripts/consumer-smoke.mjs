#!/usr/bin/env node
// Clean-consumer check: pack every workspace package, install the tarballs into
// a scratch project and import the public entry points.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = join(root, 'packages');
const packages = existsSync(pkgRoot)
  ? readdirSync(pkgRoot).filter((n) => existsSync(join(pkgRoot, n, 'package.json')))
  : [];

if (packages.length === 0) {
  console.log('consumer-smoke: no packages to pack yet, nothing to check');
  process.exit(0);
}

// Fixed expected public exports. A package absent from packages/ is skipped;
// a package that is present must pack, install and expose every export.
const EXPECTED = {
  '@veyract/redaction': { redact: 'function', truncate: 'function', MAX_REDACT_INPUT: 'number' },
  '@veyract/event-schema': {
    projectHookPayload: 'function',
    recognizeTaskTag: 'function',
    projectOtlpMetrics: 'function',
    projectOtlpLogs: 'function',
  },
};

const work = mkdtempSync(join(tmpdir(), 'vo-consumer-'));
try {
  const packDir = join(work, 'tarballs');
  mkdirSync(packDir);
  execFileSync('pnpm', ['-r', 'pack', '--pack-destination', packDir], { cwd: root, stdio: 'inherit' });
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz')).map((f) => join(packDir, f));

  const proj = join(work, 'consumer');
  mkdirSync(proj);
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: proj, stdio: 'inherit' });

  const installed = new Set(readdirSync(join(proj, 'node_modules', '@veyract')).map((n) => `@veyract/${n}`));
  let failed = false;
  for (const [name, exports] of Object.entries(EXPECTED)) {
    if (!packages.includes(name.split('/')[1])) continue; // not created yet
    if (!installed.has(name)) {
      console.error(`consumer-smoke: ${name} is in packages/ but did not install from its tarball`);
      failed = true;
      continue;
    }
    const script = `const m = await import(${JSON.stringify(name)});
const want = ${JSON.stringify(exports)};
const bad = Object.entries(want).filter(([k, t]) => typeof m[k] !== t).map(([k, t]) => k + ' (' + t + ')');
if (bad.length) { console.error('missing or wrong-typed exports: ' + bad.join(', ')); process.exit(1); }`;
    try {
      execFileSync('node', ['--input-type=module', '-e', script], { cwd: proj, stdio: 'inherit' });
      console.log(`consumer-smoke: ${name} ok`);
    } catch {
      console.error(`consumer-smoke: ${name} does not expose its expected exports`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
