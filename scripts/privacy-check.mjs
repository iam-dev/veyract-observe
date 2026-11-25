#!/usr/bin/env node
// Privacy check: flags personal/local identifiers. Prints "file:line rule" only,
// never the matched text.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  { rule: 'home-path', re: /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+/g },
  { rule: 'claude-tmp', re: /\/tmp\/claude-\d+/g },
  { rule: 'anthropic-id', re: /\b(?:toolu|req|msg)_[A-Za-z0-9]{10,}/g },
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /(?:@users\.noreply\.github\.com|@example\.invalid|@example\.com)$/i;

export function findViolations(text, extraDeny = []) {
  const out = [];
  for (const { rule, re } of RULES) {
    for (const m of text.matchAll(re)) out.push({ rule, index: m.index });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const addr = m[0];
    if (ALLOWED_EMAIL.test(addr) || ['noreply@anthropic.com', 'git@github.com'].includes(addr.toLowerCase())) continue;
    out.push({ rule: 'email', index: m.index });
  }
  const lower = text.toLowerCase();
  for (const raw of extraDeny) {
    const needle = raw.trim().toLowerCase();
    if (!needle) continue;
    let i = lower.indexOf(needle);
    while (i !== -1) {
      out.push({ rule: 'local-deny', index: i });
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function loadDenyList(cwd = process.cwd()) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    const file = join(top, '.privacy-denylist');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 256 * 1024 * 1024 });
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function main() {
  const staged = process.argv.includes('--staged');
  const deny = loadDenyList();
  let files;
  let read;
  if (staged) {
    files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
    read = (f) => git(['show', `:${f}`], 'buffer');
  } else {
    files = git(['ls-files', '-z']).split('\0').filter(Boolean);
    read = (f) => (existsSync(f) ? readFileSync(f) : Buffer.alloc(0));
  }
  let hits = 0;
  for (const f of files) {
    if (f === 'pnpm-lock.yaml' || f.endsWith('/pnpm-lock.yaml')) continue;
    const buf = read(f);
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    for (const v of findViolations(text, deny)) {
      console.error(`${f}:${lineOf(text, v.index)} ${v.rule}`);
      hits++;
    }
  }
  if (hits > 0) {
    console.error(`privacy-check: ${hits} violation(s)`);
    process.exit(1);
  }
  console.log('privacy-check: ok');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
