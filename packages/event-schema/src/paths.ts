import { posix } from 'node:path/posix';
import type { PathCategory } from './types.js';

const MAX_RELATIVE = 512;

/**
 * Lexical only: no filesystem access, no symlink resolution. Plan 2 passes real (resolved) paths.
 * Returns a normalized repo-relative POSIX path, or null if the path is not provably inside the root.
 */
export function relativePath(absPath: string, repoRoot: string | null): string | null {
  if (repoRoot === null || typeof absPath !== 'string') return null;
  if (!posix.isAbsolute(absPath) || !posix.isAbsolute(repoRoot)) return null;
  if (absPath.includes('\\') || repoRoot.includes('\\')) return null;
  const root = posix.normalize(repoRoot).replace(/\/+$/, '');
  const norm = posix.normalize(absPath);
  const prefix = root + '/';
  if (!norm.startsWith(prefix)) return null;
  const rel = norm.slice(prefix.length);
  if (rel === '' || rel.length > MAX_RELATIVE || rel.split('/').includes('..')) return null;
  return rel;
}

const CONFIG_NAMES: ReadonlySet<string> = new Set([
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Dockerfile', 'Makefile',
]);
const TEST_DIRS: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec']);

/** Coarse class of a path; precedence: none, outside, test, config, docs, source. Lexical only. */
export function pathCategory(absPath: string | undefined, repoRoot: string | null): PathCategory {
  if (absPath === undefined) return 'none';
  const rel = relativePath(absPath, repoRoot);
  if (rel === null) return 'outside';
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  if (segs.some((s) => TEST_DIRS.has(s)) || /\.(test|spec)\.[^.]+$/.test(base)) return 'test';
  if (
    CONFIG_NAMES.has(base) || base.startsWith('.env') || base.startsWith('tsconfig') || /\.config\.[^.]+$/.test(base) ||
    (segs.length === 1 && ['yml', 'yaml', 'toml', 'ini', 'json'].includes(ext)) || segs[0] === '.github'
  ) return 'config';
  if (['md', 'mdx', 'rst', 'txt'].includes(ext) || segs[0] === 'docs') return 'docs';
  return 'source';
}
