/**
 * Command classification for shell tool calls.
 *
 * HEURISTIC: this is a first-token lookup on whitespace-split input. There is no shell
 * parsing, so quoting, pipes, subshells and aliases are not understood. The result says
 * roughly what kind of command ran; it is never evidence of what was executed.
 * Arguments are never returned.
 */
import type { CommandCategory } from './types.js';

const CATEGORY_TABLE: Record<Exclude<CommandCategory, 'other'>, readonly string[]> = {
  git: ['git', 'gh'],
  test: ['pytest', 'jest', 'vitest', 'mocha', 'phpunit', 'rspec'],
  package: ['npm', 'pnpm', 'yarn', 'npx', 'pip', 'pip3', 'uv', 'poetry', 'bundle', 'composer'],
  build: ['make', 'tsc', 'cargo', 'go', 'gradle', 'mvn', 'cmake', 'bazel'],
  file: ['cd', 'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'find', 'head', 'tail', 'wc', 'sed', 'awk', 'tee', 'ln', 'stat'],
  search: ['grep', 'rg', 'fd', 'ag'],
  network: ['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc'],
  container: ['docker', 'podman', 'kubectl', 'helm'],
  observe: ['veyract'],
};

const EXECUTABLE_CATEGORY = new Map<string, CommandCategory>();
for (const [category, names] of Object.entries(CATEGORY_TABLE)) {
  for (const name of names) EXECUTABLE_CATEGORY.set(name, category as CommandCategory);
}

const SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['status', 'diff', 'log', 'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'stash', 'show', 'restore', 'reset', 'tag', 'worktree', 'clone']),
  npm: new Set(['install', 'ci', 'test', 'run', 'add', 'remove', 'build', 'exec']),
  pnpm: new Set(['install', 'ci', 'test', 'run', 'add', 'remove', 'build', 'exec']),
  yarn: new Set(['install', 'ci', 'test', 'run', 'add', 'remove', 'build', 'exec']),
  cargo: new Set(['build', 'test', 'run', 'check', 'fmt', 'clippy']),
  go: new Set(['build', 'test', 'run', 'vet', 'mod']),
  docker: new Set(['build', 'run', 'ps', 'compose', 'pull', 'push']),
  veyract: new Set(['observe']),
};

const SINGLE_WORD = new Set(['pytest', 'make', 'tsc', 'vitest', 'jest']);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokens(command: string): string[] {
  return typeof command === 'string' ? command.split(/\s+/).filter((t) => t.length > 0) : [];
}

function baseName(token: string): string {
  const i = token.lastIndexOf('/');
  return i === -1 ? token : token.slice(i + 1);
}

export function commandCategory(command: string): CommandCategory {
  const toks = tokens(command);
  let i = 0;
  while (i < toks.length && ENV_ASSIGNMENT.test(toks[i]!)) i++;
  if (toks[i] === 'sudo') i++;
  const first = toks[i];
  if (first === undefined) return 'other';
  return EXECUTABLE_CATEGORY.get(baseName(first)) ?? 'other';
}

export function restrictedForm(command: string): string | null {
  if (typeof command !== 'string') return null;
  if (/&&|\|\||;|\||`|\$\(/.test(command)) return null;
  const toks = tokens(command);
  const first = toks[0];
  if (first === undefined || ENV_ASSIGNMENT.test(first) || first === 'sudo') return null;
  const exe = baseName(first);
  if (SINGLE_WORD.has(exe)) return exe;
  const subs = SUBCOMMANDS[exe];
  const sub = toks[1];
  if (subs === undefined || sub === undefined || !subs.has(sub)) return null;
  return `${exe} ${sub}`;
}
