import { redact, truncate } from '../src/index.js';

const AKIA = 'AKIA' + 'Q'.repeat(16), GHP = 'ghp_' + 'a'.repeat(36);
test('known token formats', () => {
  for (const [secret, kind] of [[AKIA,'aws-key'],[GHP,'github-token'],['sk-ant-' + 'x'.repeat(40),'anthropic-key'],
      ['xoxb-' + '1'.repeat(24),'slack-token'],['AIza' + 'b'.repeat(35),'google-key'],
      ['eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20),'jwt']] as const) {
    const r = redact(`run ${secret} now`);
    expect(r.text).toBe(`run [REDACTED:${kind}] now`); expect(r.redactions).toBe(1);
  }
});
test('assignments, flags, bearer, url credentials, private keys', () => {
  expect(redact('PASSWORD=hunter2 x').text).toBe('PASSWORD=[REDACTED:assignment] x');
  expect(redact('api_token: abc123').text).toBe('api_token: [REDACTED:assignment]');
  expect(redact('mysql --password hunter2 db').text).toBe('mysql --password [REDACTED:flag] db');
  expect(redact('curl -H "Authorization: Bearer abc.def"').text).toContain('Bearer [REDACTED:bearer]');
  expect(redact('https://u:p4ss@host/x').text).toBe('https://[REDACTED:url-credentials]@host/x');
  expect(redact('-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----').text).toBe('[REDACTED:private-key]');
});
test('multiline, escaped quotes, repeated and overlapping secrets', () => {
  expect(redact(`a ${GHP}\nb ${GHP}`).redactions).toBe(2);
  expect(redact(`echo "token=\\"${GHP}\\""`).text).not.toContain(GHP);
  expect(redact(`TOKEN=${AKIA}`).text).not.toContain(AKIA);
});
test('unterminated private key is redacted to the end', () => {
  expect(redact('x -----BEGIN RSA PRIVATE KEY-----\nAAA').text).toBe('x [REDACTED:private-key]');
});
test('unicode preserved around redactions', () => { expect(redact(`naïve ✓ ${GHP} ✓`).text).toBe('naïve ✓ [REDACTED:github-token] ✓'); });
test('ordinary text unchanged', () => { expect(redact('git commit -m "fix spool"')).toEqual({ text: 'git commit -m "fix spool"', redactions: 0, omitted: false }); });
test('oversized input is omitted, not scanned', () => { expect(redact('a'.repeat(65_537))).toEqual({ text: '[OMITTED:oversized]', redactions: 0, omitted: true }); });
test('pathological inputs finish fast', () => {
  for (const s of ['a='.repeat(32_000), '-----BEGIN '.repeat(5_000), 'https://'.repeat(8_000), ':'.repeat(65_536)]) {
    const t = performance.now(); redact(s); expect(performance.now() - t).toBeLessThan(50);
  }
});
test('truncate never cuts inside a marker', () => {
  expect(truncate('abcdef', 3)).toBe('abc…[truncated]'); expect(truncate('ab', 3)).toBe('ab');
  expect(truncate('x [REDACTED:github-token] y', 8)).toBe('x …[truncated]');
});
