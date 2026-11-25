#!/usr/bin/env node
// Publication gate: run before anything is pushed to the public remote.
// Checks the remote URL and every commit in the range (added content,
// message, author and committer email). Prints "sha rule", never the text.
import { execFileSync } from 'node:child_process';
import { findViolations, loadDenyList } from './privacy-check.mjs';

const EXPECTED_REMOTE = 'git@github.com:iam-dev/veyract-observe.git';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(args) {
  try {
    return git(args).trim();
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

function main() {
  const i = process.argv.indexOf('--range');
  let range = i !== -1 ? process.argv[i + 1] : defaultRange();
  if (!range) {
    console.error('publication-gate: --range needs a value');
    process.exit(2);
  }
  let failures = 0;
  const fail = (what, rule) => {
    console.error(`${what} ${rule}`);
    failures++;
  };

  const remote = tryGit(['remote', 'get-url', 'origin']);
  if (remote !== EXPECTED_REMOTE) fail('remote', 'wrong-remote');

  // An all-zero base (new branch) means the whole history.
  range = range.replace(/^0{40,64}\.\./, '');
  if (range === '' || range.startsWith('..')) range = 'HEAD';
  const deny = loadDenyList();
  const shas = git(['rev-list', '--reverse', range]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const short = sha.slice(0, 10);
    const meta = git(['log', '-1', '--format=%ae%n%ce%n%an%n%cn%n%B', sha]);
    for (const v of findViolations(meta, deny)) fail(short, `${v.rule} (meta)`);
    const patch = git(['show', '--format=', '--no-renames', '--unified=0', sha]);
    const added = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    for (const v of findViolations(added, deny)) fail(short, `${v.rule} (content)`);
  }
  if (failures > 0) {
    console.error(`publication-gate: ${failures} problem(s) in ${shas.length} commit(s)`);
    process.exit(1);
  }
  console.log(`publication-gate: ok (${shas.length} commit(s) checked)`);
}

main();
