import { findViolations } from './privacy-check.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'privacy-check.mjs');
const GATE = join(here, 'publication-gate.mjs');
const REMOTE = 'git@github.com:iam-dev/veyract-observe.git';
const NOREPLY = '30754770+iam-dev@users.noreply.github.com';

// Forbidden-looking values are built from fragments so this file stays clean.
const homePath = '/ho' + 'me/alice/x';
const macPath = '/Us' + 'ers/alice/x';
const claudeTmp = '/tmp/' + 'claude-1000/x';
const toolId = 'tool' + 'u_01AbCdEfGhIj';
const reqId = 'r' + 'eq_011ChPLxqMVkLPhk';
const personalEmail = 'someone@' + 'gmail.com';

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(dir, args, env = {}) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'vo-priv-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'iam-dev']);
  git(dir, ['config', 'user.email', NOREPLY]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['remote', 'add', 'origin', REMOTE]);
  return dir;
}

function commit(dir, file, text, message = 'chore: change', env = {}) {
  writeFileSync(join(dir, file), text);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message], env);
}

function runGate(dir, range = 'HEAD~1..HEAD') {
  return spawnSync('node', [GATE, '--range', range], { cwd: dir }).status;
}

test('flags home paths, claude temp dirs, Anthropic ids, personal emails', () => {
  const rules = (t) => findViolations(t, []).map((v) => v.rule);
  expect(rules(homePath)).toContain('home-path');
  expect(rules(macPath)).toContain('home-path');
  expect(rules(claudeTmp)).toContain('claude-tmp');
  expect(rules(toolId)).toContain('anthropic-id');
  expect(rules(reqId)).toContain('anthropic-id');
  expect(rules('mail me: ' + personalEmail)).toContain('email');
});

test('allows noreply, example and placeholder text', () => {
  expect(
    findViolations(`${NOREPLY} noreply@anthropic.com x@example.invalid y@example.com <HOME>/repo pnpm@12.23.0`, []),
  ).toEqual([]);
});

test('local deny list is case-insensitive', () => {
  expect(findViolations('Built by SomeUser', ['someuser']).map((v) => v.rule)).toEqual(['local-deny']);
});

test('violations report an index and never the matched text', () => {
  expect(findViolations('ab ' + homePath, [])).toEqual([{ rule: 'home-path', index: 3 }]);
});

test('publication gate catches a value added and removed within the range, and a non-noreply author', () => {
  const leak = makeRepo();
  commit(leak, 'a.txt', 'clean\n', 'chore: base');
  commit(leak, 'a.txt', homePath + '\n', 'chore: add');
  commit(leak, 'a.txt', 'clean\n', 'chore: remove');
  expect(runGate(leak, 'HEAD~2..HEAD')).toBe(1);

  const author = makeRepo();
  commit(author, 'a.txt', 'clean\n', 'chore: base');
  commit(author, 'b.txt', 'clean\n', 'chore: other', { GIT_AUTHOR_EMAIL: personalEmail });
  expect(runGate(author)).toBe(1);

  const msg = makeRepo();
  commit(msg, 'a.txt', 'clean\n', 'chore: base');
  commit(msg, 'b.txt', 'clean\n', 'chore: mentions ' + homePath);
  expect(runGate(msg)).toBe(1);

  const clean = makeRepo();
  commit(clean, 'a.txt', 'clean\n', 'chore: base');
  commit(clean, 'b.txt', 'clean\n', 'chore: other');
  expect(runGate(clean)).toBe(0);
});

test('publication gate fails on a wrong remote URL', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'clean\n', 'chore: base');
  commit(dir, 'b.txt', 'clean\n', 'chore: other');
  git(dir, ['remote', 'set-url', 'origin', 'git@github.com:someone-else/repo.git']);
  expect(runGate(dir)).toBe(1);
});

test('--staged scans the index, not the working tree', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'clean\n', 'chore: base');
  writeFileSync(join(dir, 'a.txt'), homePath + '\n');
  git(dir, ['add', 'a.txt']);
  writeFileSync(join(dir, 'a.txt'), 'clean again\n');
  expect(() => execFileSync('node', [SCRIPT, '--staged'], { cwd: dir, stdio: 'pipe' })).toThrow();
  expect(spawnSync('node', [SCRIPT], { cwd: dir }).status).toBe(0);
});
