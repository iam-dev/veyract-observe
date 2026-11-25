/**
 * Bounded, best-effort secret redaction.
 *
 * This is a SECOND layer only: allowlist projection is the first layer and
 * decides what may be stored at all. Redaction is best effort, not a security
 * guarantee. It will miss secrets in formats it does not recognise.
 *
 * Every pattern is linear: no nested quantifiers and bounded repeats. Input
 * above MAX_REDACT_INPUT is not scanned at all. Callers always use
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

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@:]{1,128}:[^\s/@]{1,256}@/gi;
const BEARER = /\b(bearer\s{1,8})(?!\[REDACTED:)[A-Za-z0-9._~+/=-]{1,2048}/gi;

const TOKEN_FORMATS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}/g, 'github-token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,512}/g, 'anthropic-key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,200}/g, 'slack-token'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'google-key'],
  [/\beyJ[A-Za-z0-9_-]{10,512}\.eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}/g, 'jwt'],
];

const FLAG = /(--(?:password|token|secret|api-key)(?:\s{1,8}|=)["']?)(?!\[REDACTED:)[^\s"']{1,512}/gi;
const ASSIGNMENT =
  /((?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,20}\s{0,8}[=:]\s{0,8}(?:\\?["'])?)(?!\[REDACTED:)[^\s"']{1,512}/gi;

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
