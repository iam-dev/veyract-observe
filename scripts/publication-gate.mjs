#!/usr/bin/env node
// Publication gate: run before anything is pushed to the public remote.
// Checks the remote URL and every commit in the range (linear history, path
// names, full content of every changed file, message, exact author and
// committer email). Prints "sha rule", never the text.
//
// Options:
//   --range <rev-range>   commits to check (default: upstream..HEAD)
//   --remote-url <url>    URL being pushed to (default: configured remote.origin.url)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// GitHub-created merge commits already published on main (PR #1 was merged with a merge commit; the repo
// should allow rebase merges only). Exempt by full SHA from the merge and email rules only, and only while
// the merge tree equals its second parent's tree, i.e. the merge introduces nothing that was not scanned.
// Its message is still scanned.
const PUBLISHED_MERGES = new Set(['7640f5c2a033fc7fed3ed49707f9187e6a8a04e3']);

export function isExemptMerge(sha, treeOf) {
  if (!PUBLISHED_MERGES.has(sha)) return false;
  const tree = treeOf(sha);
  return typeof tree === 'string' && tree !== '' && tree === treeOf(`${sha}^2`);
}

export function isAllowedRemote(url, env = process.env) {
  if (url === EXPECTED_REMOTE) return true;
  return env.GITHUB_ACTIONS === 'true' && ACTIONS_REMOTES.includes(url);
}

// Text drawn inside pixels (screenshots, PDFs) is invisible to the pattern checks. Every media blob is
// therefore refused unless the owner has looked at that exact content and listed its git blob id in
// scripts/reviewed-media.txt ("<blob id> <path> # why"). Detected by extension and by magic bytes, so a
// renamed file is caught too.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|ico|tiff?|svg|pdf|mp4|mov|webm|mkv)$/i;
const MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x49, 0x49, 0x2a, 0x00], // TIFF (LE)
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF (BE)
  [0x42, 0x4d], // BMP
];

export function isMedia(path, blob) {
  if (MEDIA_EXT.test(path)) return true;
  if (!blob || blob.length < 4) return false;
  if (MAGIC.some((m) => m.every((b, i) => blob[i] === b))) return true;
  const ascii = (from, to) => blob.subarray(from, to).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true; // WebP
  if (ascii(4, 8) === 'ftyp') return true; // MP4 / MOV / AVIF / HEIC
  return false;
}

const REVIEWED_MEDIA = join(dirname(fileURLToPath(import.meta.url)), 'reviewed-media.txt');

export function loadReviewedMedia(file = REVIEWED_MEDIA) {
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim().split(/\s+/)[0])
      .filter((id) => /^[0-9a-f]{40}$/.test(id)),
  );
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
  const reviewedMedia = loadReviewedMedia();
  const shas = git(['rev-list', '--reverse', range]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const short = sha.slice(0, 10);
    const [parents, authorEmail, committerEmail, ...rest] = git([
      'log', '-1', '--format=%P%n%ae%n%ce%n%an%n%cn%n%B', sha,
    ]).split('\n');
    // History is linear: a merge commit's content is not shown by diff-tree, so reject it outright.
    const exemptMerge = isExemptMerge(sha, (rev) => tryGit(['rev-parse', `${rev}^{tree}`]));
    if (parents.split(' ').filter(Boolean).length > 1 && !exemptMerge) fail(short, 'merge-commit');
    if (!isEmailExempt(sha) && !exemptMerge) {
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
      if (isMedia(path, blob)) {
        const id = tryGit(['rev-parse', `${sha}:${path}`]);
        if (!id || !reviewedMedia.has(id)) fail(short, 'media-unreviewed');
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
