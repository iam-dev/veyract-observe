/**
 * Bounded, best-effort secret redaction.
 *
 * This is a SECOND layer only: allowlist projection is the first layer and
 * decides what may be stored at all. Redaction is best effort, not a security
 * guarantee. It will miss secrets in formats it does not recognise.
 *
 * Every pattern is linear: no nested quantifiers, and an unbounded repeat is
 * only used as the last element of a pattern (it either succeeds and consumes
 * the run, or is never reached), so nothing of a matched value survives and no
 * start position rescans a long run. Input above MAX_REDACT_INPUT is not
 * scanned at all. Callers always use
 * truncate(redact(x).text, n): redact first, so a cut never exposes part of a
 * recognised secret. Nothing here throws an error that contains input text.
 */

export const MAX_REDACT_INPUT = 65_536;

export interface RedactResult {
  text: string;
  redactions: number;
  omitted: boolean;
}

const marker = (kind: string): string => `[REDACTED:${kind}]`;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

// User and password classes exclude "/", so the run scanned from one "://"
// ends before the next "://": the scans are disjoint and the total is linear.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER = /\b(bearer\s{1,8})(?!\[REDACTED:)[A-Za-z0-9._~+/=-]+/gi;

const TOKEN_FORMATS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, 'github-token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic-key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack-token'],
  [/\bAIza[0-9A-Za-z_-]{35,}/g, 'google-key'],
];

// JWTs are found per dot-separated run rather than with one regex: a pattern
// with an unbounded segment followed by "." would rescan the run from every
// "eyJ" start (quadratic). The run regex has a single class and consumes each
// run once.
const DOTTED_RUN = /[A-Za-z0-9_.-]+/g;
const JWT_MIN = 10;

function jwtStart(seg: string): number {
  // "eyJ" at a word boundary: the start of the segment or right after "-".
  if (seg.startsWith('eyJ')) return 0;
  const i = seg.indexOf('-eyJ');
  return i === -1 ? -1 : i + 1;
}

function redactJwtInRun(run: string, onHit: () => void): string {
  if (!run.includes('.')) return run;
  const segs = run.split('.');
  let out = '';
  let k = 0;
  while (k < segs.length) {
    const a = segs[k] ?? '';
    const start = k + 2 < segs.length ? jwtStart(a) : -1;
    const b = segs[k + 1] ?? '';
    const c = segs[k + 2] ?? '';
    if (start !== -1 && a.length - start - 3 >= JWT_MIN && b.startsWith('eyJ') && b.length - 3 >= JWT_MIN && c.length >= JWT_MIN) {
      onHit();
      out += a.slice(0, start) + marker('jwt') + (k + 3 < segs.length ? '.' : '');
      k += 3;
      continue;
    }
    out += a + (k + 1 < segs.length ? '.' : '');
    k++;
  }
  return out;
}

const FLAG = /(--(?:password|token|secret|api-key)(?:\s{1,8}|=)["']?)(?!\[REDACTED:)[^\s"']+/gi;
// The optional (escaped) quote after the key covers JSON: {"password": "x"}.
const ASSIGNMENT =
  /((?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,20}(?:\\?["'])?\s{0,8}[=:]\s{0,8}(?:\\?["'])?)(?!\[REDACTED:)[^\s"']+/gi;

function redactPrivateKeys(text: string): { text: string; count: number } {
  let out = '';
  let pos = 0;
  let count = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (;;) {
    const begin = PRIVATE_KEY_BEGIN.exec(text);
    if (begin === null) break;
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(text);
    // An unterminated block is redacted to the end of the input. The search
    // consumes the rest of the input, so the scan stays linear.
    const stop = end === null ? text.length : end.index + end[0].length;
    out += text.slice(pos, begin.index) + marker('private-key');
    pos = stop;
    count++;
    PRIVATE_KEY_BEGIN.lastIndex = stop;
  }
  return count === 0 ? { text, count } : { text: out + text.slice(pos), count };
}

export function redact(text: string): RedactResult {
  if (text.length > MAX_REDACT_INPUT) {
    return { text: '[OMITTED:oversized]', redactions: 0, omitted: true };
  }
  let n = 0;
  const pk = redactPrivateKeys(text);
  let out = pk.text;
  n += pk.count;

  const sub = (re: RegExp, build: (m: string, p1: string) => string): void => {
    out = out.replace(re, (m: string, p1: string) => {
      n++;
      return build(m, p1);
    });
  };

  sub(URL_CREDENTIALS, (_m, scheme) => `${scheme}${marker('url-credentials')}@`);
  sub(BEARER, (_m, prefix) => `${prefix}${marker('bearer')}`);
  for (const [re, kind] of TOKEN_FORMATS) sub(re, () => marker(kind));
  out = out.replace(DOTTED_RUN, (run: string) => redactJwtInRun(run, () => n++));
  sub(FLAG, (_m, prefix) => `${prefix}${marker('flag')}`);
  sub(ASSIGNMENT, (_m, prefix) => `${prefix}${marker('assignment')}`);

  return { text: out, redactions: n, omitted: false };
}

const MARKER_RE = /\[REDACTED:[a-z-]{1,32}\]/g;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max);
  for (const m of text.matchAll(MARKER_RE)) {
    const start = m.index;
    if (start < cut && cut < start + m[0].length) {
      cut = start;
      break;
    }
  }
  const prev = text.charCodeAt(cut - 1);
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…[truncated]`;
}
