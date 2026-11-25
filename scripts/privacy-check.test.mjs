import { findViolations } from './privacy-check.mjs';
import { isEmailExempt, isAllowedRemote, resolveRange } from './publication-gate.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'privacy-check.mjs');
const GATE = join(here, 'publication-gate.mjs');
const PRE_PUSH = join(here, '..', '.githooks', 'pre-push');
const HTTPS_REMOTE = 'https://github.com/iam-dev/veyract-observe';
const ZERO = '0'.repeat(40);
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

// The gate's remote rule depends on GITHUB_ACTIONS, so tests control it explicitly.
function gateEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('GITHUB_ACTIONS' in extra)) delete env.GITHUB_ACTIONS;
  return env;
}

function runGate(dir, range = 'HEAD~1..HEAD', { env = {}, args = [] } = {}) {
  return spawnSync('node', [GATE, '--range', range, ...args], { cwd: dir, env: gateEnv(env) }).status;
}

function runPrePush(dir, stdinLine, url = REMOTE) {
  return spawnSync('sh', [PRE_PUSH, 'origin', url], { cwd: dir, input: stdinLine + '\n', env: gateEnv() }).status;
}

function head(dir) {
  return git(dir, ['rev-parse', 'HEAD']).trim();
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

test('publication gate requires the exact noreply email for author and committer', () => {
  const author = makeRepo();
  commit(author, 'a.txt', 'clean\n', 'chore: base');
  commit(author, 'b.txt', 'clean\n', 'chore: other', { GIT_AUTHOR_EMAIL: 'other@users.noreply.github.com' });
  expect(runGate(author)).toBe(1);

  const committer = makeRepo();
  commit(committer, 'a.txt', 'clean\n', 'chore: base');
  commit(committer, 'b.txt', 'clean\n', 'chore: other', { GIT_COMMITTER_EMAIL: 'other@users.noreply.github.com' });
  expect(runGate(committer)).toBe(1);
});

test('publication gate scans lines starting with ++ and file names', () => {
  const plus = makeRepo();
  commit(plus, 'a.txt', 'clean\n', 'chore: base');
  commit(plus, 'b.txt', '++' + homePath + '\n', 'chore: plus');
  expect(runGate(plus)).toBe(1);

  const named = makeRepo();
  commit(named, 'a.txt', 'clean\n', 'chore: base');
  mkdirSync(join(named, 'sub/ho' + 'me/alice'), { recursive: true });
  commit(named, 'sub/ho' + 'me/alice/f.txt', 'clean\n', 'chore: named');
  expect(runGate(named)).toBe(1);
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

test('publication gate accepts the https origin only inside GitHub Actions', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'clean\n', 'chore: base');
  commit(dir, 'b.txt', 'clean\n', 'chore: other');
  for (const url of [HTTPS_REMOTE, HTTPS_REMOTE + '.git']) {
    git(dir, ['remote', 'set-url', 'origin', url]);
    expect(runGate(dir, 'HEAD~1..HEAD', { env: { GITHUB_ACTIONS: 'true' } })).toBe(0);
    expect(runGate(dir)).toBe(1);
    expect(runGate(dir, 'HEAD~1..HEAD', { env: { GITHUB_ACTIONS: 'false' } })).toBe(1);
  }
  git(dir, ['remote', 'set-url', 'origin', 'https://github.com/someone-else/veyract-observe']);
  expect(runGate(dir, 'HEAD~1..HEAD', { env: { GITHUB_ACTIONS: 'true' } })).toBe(1);
  expect(isAllowedRemote(REMOTE, {})).toBe(true);
  expect(isAllowedRemote(HTTPS_REMOTE, {})).toBe(false);
  expect(isAllowedRemote(HTTPS_REMOTE + '/', { GITHUB_ACTIONS: 'true' })).toBe(false);
});

test('--remote-url overrides the origin URL', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'clean\n', 'chore: base');
  commit(dir, 'b.txt', 'clean\n', 'chore: other');
  expect(runGate(dir, 'HEAD~1..HEAD', { args: ['--remote-url', REMOTE] })).toBe(0);
  expect(runGate(dir, 'HEAD~1..HEAD', { args: ['--remote-url', 'git@github.com:someone-else/repo.git'] })).toBe(1);
  git(dir, ['remote', 'set-url', 'origin', 'git@github.com:someone-else/repo.git']);
  expect(runGate(dir, 'HEAD~1..HEAD', { args: ['--remote-url', REMOTE] })).toBe(0);
});

test('email exemption applies to the GitHub-created root commit only, by full SHA', () => {
  const root = 'aa093a3ed3c3b2bc829bccd519cb393481f6f9b0';
  expect(isEmailExempt(root)).toBe(true);
  expect(isEmailExempt(root.slice(0, 10))).toBe(false);
  expect(isEmailExempt(root.toUpperCase())).toBe(false);
  expect(isEmailExempt('ba093a3ed3c3b2bc829bccd519cb393481f6f9b0')).toBe(false);
  expect(isEmailExempt('')).toBe(false);
});

test('publication gate rejects merge commits', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'clean\n', 'chore: base');
  git(dir, ['checkout', '-q', '-b', 'side']);
  commit(dir, 'b.txt', 'clean\n', 'chore: side');
  git(dir, ['checkout', '-q', 'main']);
  commit(dir, 'c.txt', 'clean\n', 'chore: main');
  git(dir, ['merge', '-q', '--no-ff', '-m', 'chore: merge', 'side']);
  expect(runGate(dir, 'HEAD~1..HEAD')).toBe(1); // the merge plus the side commit
  expect(runGate(dir, 'HEAD^1~1..HEAD^1')).toBe(0); // the linear first-parent commit alone is clean
});

test('pre-push hook scans exactly the pushed range against the pushed URL', () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', homePath + '\n', 'chore: old leak');
  const old = head(dir);
  commit(dir, 'a.txt', 'clean\n', 'chore: fix');
  const clean = head(dir);
  const line = (local, remote) => `refs/heads/main ${local} refs/heads/main ${remote}`;

  expect(runPrePush(dir, line(clean, old))).toBe(0); // only the clean commit is pushed
  expect(runPrePush(dir, line(clean, ZERO))).toBe(1); // new branch: full history includes the leak
  expect(runPrePush(dir, line(clean, old), 'git@github.com:someone-else/repo.git')).toBe(1); // URL from git, not origin
  expect(runPrePush(dir, `(delete) ${ZERO} refs/heads/old ${old}`, 'git@github.com:someone-else/repo.git')).toBe(0); // deletion: nothing to scan

  commit(dir, 'b.txt', '++' + homePath + '\n', 'chore: new leak');
  expect(runPrePush(dir, line(head(dir), clean))).toBe(1);
  expect(runPrePush(dir, `${line(clean, old)}\n${line(head(dir), clean)}`)).toBe(1); // any failing ref fails the push
});

test('resolveRange: empty, all-zero or unknown base means the whole history of head', () => {
  const known = (rev) => rev === 'abc';
  expect(resolveRange(`${ZERO}..def`, known)).toBe('def');
  expect(resolveRange('..def', known)).toBe('def');
  expect(resolveRange('gone..def', known)).toBe('def');
  expect(resolveRange('abc..def', known)).toBe('abc..def');
  expect(resolveRange('abc..', known)).toBe('abc..HEAD');
  expect(resolveRange('def', known)).toBe('def');
  expect(resolveRange('', known)).toBe('HEAD');
  expect(resolveRange('abc...def', known)).toBe('abc...def');
});
