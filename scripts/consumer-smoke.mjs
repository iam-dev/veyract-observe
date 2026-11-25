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

// Entry points the clean consumer must be able to import, and the export each must have.
const CHECKS = [
  { name: '@veyract/event-schema', exportName: 'projectHookEvent' },
  { name: '@veyract/redaction', exportName: 'redactText' },
];

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
  for (const { name, exportName } of CHECKS) {
    if (!installed.has(name)) continue; // package not created yet
    const script = `const m = await import(${JSON.stringify(name)}); if (typeof m[${JSON.stringify(exportName)}] !== 'function') { console.error('missing export ${exportName} in ${name}'); process.exit(1); }`;
    execFileSync('node', ['--input-type=module', '-e', script], { cwd: proj, stdio: 'inherit' });
    console.log(`consumer-smoke: ${name} ok`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
