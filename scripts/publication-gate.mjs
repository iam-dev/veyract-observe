#!/usr/bin/env node
// Publication gate: run before anything is pushed to the public remote.
// Checks the remote URL and every commit in the range (linear history, path
// names, full content of every changed file, message, exact author and
// committer email). Prints "sha rule", never the text.
//
// Options:
//   --range <rev-range>   commits to check (default: upstream..HEAD)
//   --remote-url <url>    URL being pushed to (default: configured remote.origin.url)
import { findViolations, git, isMain, loadDenyList } from './privacy-check.mjs';

const REQUIRED_EMAIL = '30754770+iam-dev@users.noreply.github.com';
const EXPECTED_REMOTE = 'git@github.com:iam-dev/veyract-observe.git';
// actions/checkout sets origin to the https URL; accepted only inside GitHub Actions.
const ACTIONS_REMOTES = ['https://github.com/iam-dev/veyract-observe', 'https://github.com/iam-dev/veyract-observe.git'];
// The GitHub-created root commit (adds only LICENSE; committer is GitHub's
// noreply address). Exempt from the email rules only, by full SHA; its paths
// and content are still scanned.
const EMAIL_EXEMPT_COMMITS = new Set(['aa093a3ed3c3b2bc829bccd519cb393481f6f9b0']);

export function isEmailExempt(sha) {
  return EMAIL_EXEMPT_COMMITS.has(sha);
}

export function isAllowedRemote(url, env = process.env) {
  if (url === EXPECTED_REMOTE) return true;
  return env.GITHUB_ACTIONS === 'true' && ACTIONS_REMOTES.includes(url);
}

function tryGit(args) {
  try {
    return git(args, { quiet: true }).trim();
  } catch {
    return null;
  }
}

function defaultRange() {
  const upstream = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) return `${upstream}..HEAD`;
  if (tryGit(['rev-parse', '--verify', 'origin/main'])) return 'origin/main..HEAD';
  return 'HEAD';
}

function option(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined) {
    console.error(`publication-gate: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

/**
 * `base..head` with a base that is empty, all-zero (new branch) or not a known commit (e.g. a force-pushed
 * CI "before") means the whole history of head. Callers pass the raw values; this is the only place that
 * resolves them.
 */
export function resolveRange(range, isCommit) {
  const i = range.indexOf('..');
  if (i === -1 || range.includes('...')) return range || 'HEAD';
  const base = range.slice(0, i);
  const head = range.slice(i + 2) || 'HEAD';
  return base === '' || /^0+$/.test(base) || !isCommit(base) ? head : `${base}..${head}`;
}

function main() {
  const range = resolveRange(option('--range') ?? defaultRange(), (rev) => tryGit(['cat-file', '-e', `${rev}^{commit}`]) !== null);
  let failures = 0;
  const fail = (what, rule) => {
    console.error(`${what} ${rule}`);
    failures++;
  };

  // The configured URL, not `remote get-url`: that applies url.*.insteadOf rewrites (e.g. ssh → https).
  const remote = option('--remote-url') ?? tryGit(['config', '--get', 'remote.origin.url']);
  if (!isAllowedRemote(remote)) fail('remote', 'wrong-remote');

  const deny = loadDenyList();
  const shas = git(['rev-list', '--reverse', range]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const short = sha.slice(0, 10);
    const [parents, authorEmail, committerEmail, ...rest] = git([
      'log', '-1', '--format=%P%n%ae%n%ce%n%an%n%cn%n%B', sha,
    ]).split('\n');
    // History is linear: a merge commit's content is not shown by diff-tree, so reject it outright.
    if (parents.split(' ').filter(Boolean).length > 1) fail(short, 'merge-commit');
    if (!isEmailExempt(sha)) {
      if (authorEmail !== REQUIRED_EMAIL) fail(short, 'author-email');
      if (committerEmail !== REQUIRED_EMAIL) fail(short, 'committer-email');
    }
    for (const v of findViolations(rest.join('\n'), deny)) fail(short, `${v.rule} (meta)`);

    const paths = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha])
      .split('\0')
      .filter(Boolean);
    for (const path of paths) {
      for (const v of findViolations(path, deny)) fail(short, `${v.rule} (path)`);
      let blob;
      try {
        blob = git(['show', `${sha}:${path}`], { encoding: 'buffer', quiet: true });
      } catch {
        continue; // deleted in this commit: the path was scanned above
      }
      // latin1 keeps ASCII patterns intact in binary blobs too.
      for (const v of findViolations(blob.toString('latin1'), deny)) fail(short, `${v.rule} (content)`);
    }
  }
  if (failures > 0) {
    console.error(`publication-gate: ${failures} problem(s) in ${shas.length} commit(s)`);
    process.exit(1);
  }
  console.log(`publication-gate: ok (${shas.length} commit(s) checked)`);
}

if (isMain(import.meta.url)) main();
