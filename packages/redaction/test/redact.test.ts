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
    const t = performance.now(); redact(s); expect(performance.now() - t).toBeLessThan(200);
  }
});
test('pathological inputs for the unbounded value patterns finish fast', () => {
  const eyj = 'ey' + 'J';
  for (const s of [
    `-${eyj}`.repeat(16_000), `${eyj}${'a'.repeat(65_000)}`, `${eyj}${'a'.repeat(20)}.`.repeat(2_500),
    `${eyj}${'a'.repeat(20)}.${eyj}`.repeat(2_000), 'sk-' + 'ant-'.repeat(16_000), 'ghp_'.repeat(16_000),
    'password'.repeat(8_000), 'token":'.repeat(9_000), 'Bearer '.repeat(9_000), 'a://x:'.repeat(10_000),
    'a://' + 'x:'.repeat(30_000), '--password='.repeat(5_000), '.'.repeat(65_536), 'a.'.repeat(32_768),
  ]) {
    expect(s.length).toBeLessThanOrEqual(65_536);
    const t = performance.now(); redact(s); expect(performance.now() - t).toBeLessThan(200);
  }
});
test('over-long secrets leave no tail', () => {
  // Values are built from fragments; each check asserts nothing of the value survives.
  const tail = (n: number, c = 'x') => c.repeat(n);
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['TO' + 'KEN=', tail(600), 'TOKEN=[REDACTED:assignment]'],
    ['--pass' + 'word ', tail(600), '--password [REDACTED:flag]'],
    ['--pass' + 'word=', tail(600), '--password=[REDACTED:flag]'],
    ['Authorization: Bea' + 'rer ', tail(3_000), 'Authorization: Bearer [REDACTED:bearer]'],
    ['gh' + 'p_', tail(300, 'a'), '[REDACTED:github-token]'],
    ['sk-' + 'ant-', tail(900), '[REDACTED:anthropic-key]'],
    ['xo' + 'xb-', tail(400, '1'), '[REDACTED:slack-token]'],
    ['AI' + 'za', tail(300, 'b'), '[REDACTED:google-key]'],
    ['https://user:', tail(400, 'p') + '@host', 'https://[REDACTED:url-credentials]@host'],
    ['https://', tail(300, 'u') + ':p4ss@host', 'https://[REDACTED:url-credentials]@host'],
  ];
  for (const [prefix, value, expected] of cases) {
    const r = redact(`${prefix}${value} end`);
    expect(r.text).toBe(`${expected} end`);
    expect(r.text).not.toContain(tail(8, value[0]));
  }
});
test('JWTs with long segments are redacted whole', () => {
  const eyj = 'ey' + 'J';
  for (const [a, b, c] of [[600, 20, 20], [20, 600, 20], [20, 20, 3_000], [1_000, 1_000, 1_000]] as const) {
    const jwt = `${eyj}${'a'.repeat(a)}.${eyj}${'b'.repeat(b)}.${'c'.repeat(c)}`;
    const r = redact(`auth ${jwt} end`);
    expect(r.text).toBe('auth [REDACTED:jwt] end'); expect(r.redactions).toBe(1);
  }
  const short = `${eyj}${'a'.repeat(20)}.${eyj}${'b'.repeat(20)}.${'c'.repeat(20)}`;
  expect(redact(`x-${short}.more`).text).toBe('x-[REDACTED:jwt].more');
  expect(redact(`${short} ${short}`).redactions).toBe(2);
  expect(redact(`v1.2.3 a.b.c ${eyj}x.${eyj}y.z`).redactions).toBe(0);
});
test('JSON-style keys with quotes are redacted', () => {
  const pw = 'hun' + 'ter2', tok = 'a' + 'bc';
  expect(redact(`{"pass` + `word": "${pw}"}`).text).toBe('{"password": "[REDACTED:assignment]"}');
  expect(redact(`{"to` + `ken":"${tok}"}`).text).toBe('{"token":"[REDACTED:assignment]"}');
  expect(redact(`{'api_` + `key': '${tok}'}`).text).toBe(`{'api_key': '[REDACTED:assignment]'}`);
  expect(redact(`{\\"sec` + `ret\\":\\"${pw}\\"}`).text).not.toContain(pw);
});
test('truncate never cuts inside a marker', () => {
  expect(truncate('abcdef', 3)).toBe('abc…[truncated]'); expect(truncate('ab', 3)).toBe('ab');
  expect(truncate('x [REDACTED:github-token] y', 8)).toBe('x …[truncated]');
});
test('quoted values with spaces leave nothing behind', () => {
  const w1 = 'hun' + 'ter', w2 = 'two' + 'words';
  for (const [input, expected] of [
    [`mysql --pass` + `word "${w1} ${w2}" db`, 'mysql --password "[REDACTED:flag]" db'],
    [`--pass` + `word='${w1} ${w2}' x`, `--password='[REDACTED:flag]' x`],
    [`PASS` + `WORD="${w1} ${w2}" cmd`, 'PASSWORD="[REDACTED:assignment]" cmd'],
    [`{"to` + `ken": "${w1} ${w2}", "user": "u"}`, '{"token": "[REDACTED:assignment]", "user": "u"}'],
    [`--to` + `ken "${w1} ${w2}`, '--token "[REDACTED:flag]'], // unterminated: redacted to end of line
  ] as const) {
    const r = redact(input);
    expect(r.text).toBe(expected);
    expect(r.text).not.toContain(w1);
    expect(r.text).not.toContain(w2);
  }
  expect(redact(`--pass` + `word "a b"\nnext line`).text).toBe('--password "[REDACTED:flag]"\nnext line');
});
test('pathological quoted inputs finish fast', () => {
  for (const s of ['password="'.repeat(6_500), `--password "${'x '.repeat(30_000)}`, `token='`.repeat(9_000)]) {
    expect(s.length).toBeLessThanOrEqual(65_536);
    const t = performance.now(); redact(s); expect(performance.now() - t).toBeLessThan(200);
  }
});
test('R3-02: escaped quotes, multi-line values and embedded markers leave nothing behind', () => {
  const a = 'fir' + 'st', b = 'sec' + 'ond';
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`--pass` + `word "${a}\\"${b}" db`, '--password "[REDACTED:flag]" db'],
    [`PASS` + `WORD='${a}\\'${b}' x`, `PASSWORD='[REDACTED:assignment]' x`],
    [`--to` + `ken "${a}\n${b}" end`, '--token "[REDACTED:flag]" end'],
    [`{\\"sec` + `ret\\":\\"${a}\\"}`, '{\\"secret\\":\\"[REDACTED:assignment]\\"}'],
    [`--pass` + `word "${a}\n${b}`, '--password "[REDACTED:flag]'], // unterminated: to the end of the input
  ];
  for (const [input, expected] of cases) {
    const r = redact(input);
    expect(r.text, input).toBe(expected);
    expect(r.text).not.toContain(a);
    expect(r.text).not.toContain(b);
  }
  // A value that starts with a marker from an earlier pass is still redacted as a whole.
  const ghp = 'gh' + 'p_' + 'A'.repeat(36);
  const marked = redact(`--pass` + `word "${ghp} ${b}" x`);
  expect(marked.text).toBe('--password "[REDACTED:flag]" x');
  // A value that is exactly one marker is not redacted twice.
  expect(redact(`--pass` + `word="${a}"`).text).toBe('--password="[REDACTED:flag]"');
  expect(redact(`--pass` + `word="${a}"`).redactions).toBe(1);
});
test('R3-02: pathological escaped input finishes fast', () => {
  for (const s of [`--password "${'\\"'.repeat(32_000)}`, `password=\\"${'\\x'.repeat(32_000)}`, `token='${"\\'".repeat(32_000)}`]) {
    expect(s.length).toBeLessThanOrEqual(65_536);
    const t = performance.now(); redact(s); expect(performance.now() - t).toBeLessThan(200);
  }
});
