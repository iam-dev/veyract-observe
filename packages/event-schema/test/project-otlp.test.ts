import {
  projectOtlpMetrics, projectOtlpLogs, parseNanos, nanosToMs, MAX_OTLP_BODY_BYTES,
  type DetailLevel, type HashFn,
} from '../src/index.js';

const SID = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
const hash: HashFn = (k, v) => `${k}:${v.length}`;
const ctxAt = (level: DetailLevel, h: HashFn = hash) => ({ level, hash: h });
const ctxMeta = ctxAt('metadata');

type Attrs = Record<string, string | number | boolean>;
interface PointSpec {
  name?: string; unit?: string; temporality?: unknown; monotonic?: unknown;
  start?: unknown; end?: unknown; asDouble?: unknown; asInt?: unknown; flags?: unknown; attrs?: Attrs;
}

function anyValue(v: string | number | boolean) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}
const attrList = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: anyValue(v) }));

/** Spike shape: one resourceMetrics, one scopeMetrics, one metric per point spec. */
function metricsBody(points: PointSpec[], resource: Attrs = {
  'host.arch': 'x64', 'os.type': 'linux', 'os.version': '6.0.0', 'service.name': 'claude-code', 'service.version': '2.1.332',
}) {
  return {
    resourceMetrics: [{
      resource: { attributes: attrList(resource) },
      scopeMetrics: [{
        scope: { name: 'com.anthropic.claude_code', version: '2.1.332' },
        metrics: points.map((p) => {
          const dp: Record<string, unknown> = { attributes: attrList(p.attrs ?? {}) };
          if (p.start !== undefined) dp.startTimeUnixNano = p.start;
          if (p.end !== undefined) dp.timeUnixNano = p.end;
          if (p.asDouble !== undefined) dp.asDouble = p.asDouble;
          if (p.asInt !== undefined) dp.asInt = p.asInt;
          if (p.flags !== undefined) dp.flags = p.flags;
          return { name: p.name, unit: p.unit, sum: { dataPoints: [dp], aggregationTemporality: p.temporality, isMonotonic: p.monotonic } };
        }),
      }],
    }],
  };
}

function cost(attrs: Attrs, patch: Partial<PointSpec> = {}): PointSpec {
  return {
    name: 'claude_code.cost.usage', unit: 'USD', temporality: 1, monotonic: true,
    start: '1795595877842000000', end: '1795595879229000000', asDouble: 0.5, attrs, ...patch,
  };
}

/** Test-only FNV-1a: distinct values give distinct short digests; the input is never echoed. */
const fnvHash: HashFn = (k, v) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${k}:${h.toString(16)}`;
};

// ----------------------------------------------------------------------------------------------
// Brief cases
// ----------------------------------------------------------------------------------------------
test('exact conversion with ns interval, stream key and session', () => {
  const { samples } = projectOtlpMetrics(metricsBody([{ name: 'claude_code.cost.usage', unit: 'USD', temporality: 1, monotonic: true,
    start: '1795595877842000000', end: '1795595879229000000', asDouble: 0.00228769,
    attrs: { 'session.id': SID, model: 'claude-haiku-5-5', 'user.email': 'x@example.invalid' } }]), ctxMeta);
  expect(samples[0]).toMatchObject({ sessionId: SID, unit: 'micro_usd', value: 2288, startNs: '1795595877842000000', endNs: '1795595879229000000',
    startMs: 1795595877842, endMs: 1795595879229, temporality: 'delta', monotonic: true, attributes: { model: { name: 'claude-haiku-5-5' } } });
  expect(samples[0]!.streamKey).toMatch(/^stream:/);
  expect(JSON.stringify(samples)).not.toContain('example.invalid');
});
test('19-digit nanosecond strings parse exactly', () => {
  expect(parseNanos('1795600800123456789')).toBe('1795600800123456789');
  expect(nanosToMs('1795600800123456789')).toBe(1795600800123);
  expect(parseNanos(2 ** 60)).toBeNull();
});
test('streams differing only in dropped identity attributes keep different keys', () => {
  // The default fake keys only on length ('u-1' and 'u-2' collide); FNV-1a keys on the value itself.
  const ctx = ctxAt('metadata', fnvHash);
  const a = projectOtlpMetrics(metricsBody([cost({ 'session.id': SID, 'user.account_uuid': 'u-1' })]), ctx).samples[0]!;
  const b = projectOtlpMetrics(metricsBody([cost({ 'session.id': SID, 'user.account_uuid': 'u-2' })]), ctx).samples[0]!;
  expect(a.streamKey).toMatch(/^stream:[0-9a-f]+$/);
  expect(a.streamKey).not.toBe(b.streamKey);
  expect(JSON.stringify([a, b])).not.toContain('u-1');
  expect(JSON.stringify([a, b])).not.toContain('u-2');
});
test.each([
  ['unsafe numeric timestamp', { start: 2 ** 60, end: 2 ** 60 + 1 }],
  ['negative cost', { asDouble: -1 }], ['NaN', { asDouble: NaN }], ['Infinity', { asDouble: Infinity }],
  ['end before start', { start: '2000', end: '1000' }], ['unexpected unit', { unit: 'EUR' }],
  ['unknown temporality', { temporality: 0 }], ['excessive value', { asDouble: 2_000_000 }],
])('rejects %s', (_, patch) => { expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': SID }, patch)]), ctxMeta)).toMatchObject({ samples: [], rejected: 1 }); });
test('missing start → unknown interval; no-recorded-value → noValue, not zero', () => {
  expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': SID }, { start: undefined })]), ctxMeta).samples[0]).toMatchObject({ startNs: null, startMs: null });
  expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': SID }, { flags: 1 })]), ctxMeta)).toMatchObject({ samples: [], noValue: 1 });
});
test('missing session id stays null; unknown model pseudonymised at metadata; type enum', () => {
  const r = projectOtlpMetrics(metricsBody([
    cost({}),
    cost({ 'session.id': SID, model: 'acme-internal-llm' }),
    { name: 'claude_code.active_time.total', unit: 's', temporality: 1, start: '1', end: '2000000', asDouble: 1.5, attrs: { 'session.id': SID, type: 'weird' } },
  ]), ctxMeta);
  expect(r.samples[0]!.sessionId).toBeNull();
  expect(r.samples[1]!.attributes.model).toEqual({ name: 'other', pseudonym: 'model:17' });
  expect(r.samples[2]).toMatchObject({ unit: 'ms', value: 1500, attributes: { type: 'other' } });
});
test('never throws; logs rejected', () => {
  expect(() => projectOtlpMetrics(null, ctxMeta)).not.toThrow();
  expect(projectOtlpMetrics({ resourceMetrics: 'x' }, ctxMeta)).toMatchObject({ samples: [], rejected: 1 });
  expect(projectOtlpLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}, {}] }] }] })).toEqual({ accepted: 0, rejected: 2 });
});

// ----------------------------------------------------------------------------------------------
// Additional cases
// ----------------------------------------------------------------------------------------------
describe('instruments, units and values', () => {
  const tok = (patch: Partial<PointSpec> = {}): PointSpec => ({
    name: 'claude_code.token.usage', unit: 'tokens', temporality: 2, monotonic: true, start: '1', end: '2', asDouble: 1200,
    attrs: { 'session.id': SID, type: 'cacheRead', model: 'claude-opus-5-5' }, ...patch,
  });
  test('tokens: integer, cumulative, type kept', () => {
    expect(projectOtlpMetrics(metricsBody([tok()]), ctxMeta).samples[0]).toMatchObject({
      instrument: 'claude_code.token.usage', unit: 'tokens', value: 1200, temporality: 'cumulative', monotonic: true,
      attributes: { type: 'cacheRead', model: { name: 'claude-opus-5-5' } }, source: 'claude-code-otlp',
    });
    expect(projectOtlpMetrics(metricsBody([tok({ asDouble: undefined, asInt: '1000000000' })]), ctxMeta).samples[0]!.value).toBe(1_000_000_000);
  });
  test.each([
    ['fractional tokens', { asDouble: 1.5 }], ['too many tokens', { asDouble: 1_000_000_001 }],
    ['token unit mismatch', { unit: 'USD' }], ['negative tokens', { asInt: '-1', asDouble: undefined }],
  ])('tokens: rejects %s', (_, patch) => {
    expect(projectOtlpMetrics(metricsBody([tok(patch)]), ctxMeta)).toMatchObject({ samples: [], rejected: 1 });
  });
  test.each(['input', 'output', 'cacheRead', 'cacheCreation'])('tokens type %s kept', (type) => {
    expect(projectOtlpMetrics(metricsBody([tok({ attrs: { type } })]), ctxMeta).samples[0]!.attributes.type).toBe(type);
  });
  test('cost carries no type; session count carries no type', () => {
    const r = projectOtlpMetrics(metricsBody([
      cost({ type: 'input' }),
      { name: 'claude_code.session.count', unit: '', temporality: 1, end: '5', asInt: '1', attrs: { type: 'x' } },
      { name: 'claude_code.session.count', unit: 'count', temporality: 1, end: '5', asInt: 2 },
    ]), ctxMeta);
    expect(r.rejected).toBe(0);
    expect(r.samples.map((s) => s.attributes)).toEqual([{}, {}, {}]);
    expect(r.samples.slice(1).map((s) => [s.unit, s.value])).toEqual([['count', 1], ['count', 2]]);
  });
  test('active time: {user, cli}; bounds 0..86400 s', () => {
    const at = (asDouble: unknown, type = 'cli'): PointSpec => ({
      name: 'claude_code.active_time.total', unit: 's', temporality: 1, end: '9', asDouble, attrs: { type },
    });
    const r = projectOtlpMetrics(metricsBody([at(86_400), at(0, 'user'), at(86_400.001), at(-0.1)]), ctxMeta);
    expect(r.samples.map((s) => [s.value, s.attributes.type])).toEqual([[86_400_000, 'cli'], [0, 'user']]);
    expect(r.rejected).toBe(2);
  });
  test('cost rounds half-up to micro-USD at the bounds', () => {
    const r = projectOtlpMetrics(metricsBody([
      cost({}, { asDouble: 0.0000005 }), cost({}, { asDouble: 0 }), cost({}, { asDouble: 1_000_000 }), cost({}, { asDouble: 1_000_000.01 }),
    ]), ctxMeta);
    expect(r.samples.map((s) => s.value)).toEqual([1, 0, 1_000_000_000_000]);
    expect(r.rejected).toBe(1);
  });
  test.each([
    ['unknown instrument', { name: 'claude_code.lines_of_code.count' }], ['missing name', { name: undefined }],
    ['missing unit', { unit: undefined }], ['missing end', { end: undefined }], ['invalid start', { start: 'abc' }],
    ['no value', { asDouble: undefined }], ['string temporality', { temporality: '1' }],
    ['non-integer flags', { flags: '1' }], ['non-boolean isMonotonic', { monotonic: 'yes' }],
  ])('rejects %s', (_, patch) => {
    expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': SID }, patch)]), ctxMeta)).toMatchObject({ samples: [], rejected: 1 });
  });
  test('monotonic defaults to false; flags without bit 0 still yield a sample', () => {
    expect(projectOtlpMetrics(metricsBody([cost({}, { monotonic: undefined, flags: 2 })]), ctxMeta).samples[0]!.monotonic).toBe(false);
  });
  test('cost rounds the decimal value, not the binary product', () => {
    // Math.round(0.0001245 * 1e6) === 124 (product is 124.49999…); the decimal value 124.5 rounds half-up to 125.
    expect(projectOtlpMetrics(metricsBody([cost({}, { asDouble: 0.0001245 })]), ctxMeta).samples[0]!.value).toBe(125);
  });
  test('start of 0 means unset (unknown interval)', () => {
    expect(projectOtlpMetrics(metricsBody([cost({}, { start: '0' })]), ctxMeta).samples[0]).toMatchObject({ startNs: null, startMs: null });
  });
  test('end equal to start is accepted', () => {
    expect(projectOtlpMetrics(metricsBody([cost({}, { start: '5', end: '5' })]), ctxMeta).samples).toHaveLength(1);
  });
});

describe('attributes', () => {
  test('non-UUID session id → null, never inferred', () => {
    expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': 'not-a-uuid' })]), ctxMeta).samples[0]!.sessionId).toBeNull();
    expect(projectOtlpMetrics(metricsBody([cost({ 'session.id': 7 })]), ctxMeta).samples[0]!.sessionId).toBeNull();
  });
  test('model readability by level', () => {
    const one = (model: string, level: DetailLevel) =>
      projectOtlpMetrics(metricsBody([cost({ model })]), ctxAt(level)).samples[0]!.attributes.model;
    for (const level of ['metadata', 'detailed', 'sensitive-local'] as const) {
      expect(one('claude-sonnet-5-5', level)).toEqual({ name: 'claude-sonnet-5-5' });
      expect(one('bad model/name', level)).toEqual({ name: 'other', pseudonym: 'model:14' });
    }
    expect(one('acme-internal-llm', 'detailed')).toEqual({ name: 'acme-internal-llm' });
    expect(one('acme:llm.v2', 'sensitive-local')).toEqual({ name: 'acme:llm.v2' });
    expect(one('claude-' + 'a'.repeat(49), 'metadata')).toEqual({ name: 'other', pseudonym: 'model:56' });
  });
  test('identity and other attributes never appear in samples', () => {
    const planted = {
      'session.id': SID, 'user.id': 'planted-user-id', 'user.email': 'x@example.invalid', 'user.account_uuid': 'planted-acct-uuid',
      'user.account_id': 'planted-acct-id', 'organization.id': 'planted-org', 'anthropic.custom_base_url': 'https://planted.example.invalid',
      'anthropic.plan': 'planted-plan', 'terminal.type': 'planted-term', query_source: 'planted-qs', effort: 'planted-effort',
    };
    const r = projectOtlpMetrics(metricsBody([cost(planted)], { 'host.arch': 'planted-arch', 'service.name': 'planted-svc' }), ctxAt('sensitive-local'));
    expect(r.samples).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/planted|example\.invalid/);
    expect(Object.keys(r.samples[0]!).sort()).toEqual([
      'attributes', 'endMs', 'endNs', 'instrument', 'monotonic', 'sessionId', 'source', 'startMs', 'startNs', 'streamKey',
      'temporality', 'unit', 'value',
    ]);
  });
  test('stream key is independent of attribute order and changes with resource, scope and point identity', () => {
    const ctx = ctxAt('metadata', fnvHash);
    const key = (body: unknown) => projectOtlpMetrics(body, ctx).samples[0]!.streamKey;
    const base = key(metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' })]));
    expect(key(metricsBody([cost({ model: 'claude-opus-5-5', 'session.id': SID })]))).toBe(base);
    // Interval and value are not part of stream identity.
    expect(key(metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' }, { asDouble: 3, start: '9', end: '10' })]))).toBe(base);
    expect(key(metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' })], { 'host.arch': 'arm64' }))).not.toBe(base);
    expect(key(metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' }, { temporality: 2 })]))).not.toBe(base);
    expect(key(metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' }, { monotonic: false })]))).not.toBe(base);
    const scoped = metricsBody([cost({ 'session.id': SID, model: 'claude-opus-5-5' })]);
    scoped.resourceMetrics[0]!.scopeMetrics[0]!.scope.version = '9.9.9';
    expect(key(scoped)).not.toBe(base);
  });
  test('the hash sees canonical sorted JSON, and only stream/model kinds are hashed', () => {
    const seen: Array<[string, string]> = [];
    const spy: HashFn = (k, v) => { seen.push([k, v]); return `${k}:x`; };
    projectOtlpMetrics(metricsBody([cost({ 'session.id': SID, b: 'B', a: 'A' })], { z: '1', y: '2' }), ctxAt('metadata', spy));
    expect(seen).toHaveLength(1);
    const [kind, canon] = seen[0]!;
    expect(kind).toBe('stream');
    const parsed = JSON.parse(canon) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['instrument', 'monotonic', 'pointAttributes', 'resource', 'scope', 'temporality', 'unit']);
    expect([1, 2]).toContain(parsed['temporality']); // the OTLP enum code, not the 'delta' / 'cumulative' label
    expect(canon.indexOf('"a"')).toBeLessThan(canon.indexOf('"b"'));
    expect(canon.indexOf('"y"')).toBeLessThan(canon.indexOf('"z"'));
  });
});

describe('untrusted structure', () => {
  test.each([
    ['undefined', undefined], ['number', 1], ['string', '{}'], ['array', []],
  ])('non-object body %s → rejected 1', (_, body) => {
    expect(projectOtlpMetrics(body, ctxMeta)).toEqual({ samples: [], rejected: 1, noValue: 0 });
  });
  test('empty export is valid', () => {
    expect(projectOtlpMetrics({}, ctxMeta)).toEqual({ samples: [], rejected: 0, noValue: 0 });
    expect(projectOtlpMetrics({ resourceMetrics: [] }, ctxMeta)).toEqual({ samples: [], rejected: 0, noValue: 0 });
  });
  test('malformed nodes are counted, good siblings survive', () => {
    const body = metricsBody([cost({}), cost({})]);
    const scope = body.resourceMetrics[0]!.scopeMetrics[0]!;
    (scope.metrics as unknown[]).push(null, { name: 'claude_code.cost.usage', unit: 'USD', gauge: {} },
      { name: 'claude_code.cost.usage', unit: 'USD', sum: { aggregationTemporality: 1, dataPoints: [null, 'x', cost({})] } });
    (body.resourceMetrics as unknown[]).push(7, { scopeMetrics: 'x' });
    const r = projectOtlpMetrics(body, ctxMeta);
    expect(r.samples).toHaveLength(2);
    expect(r.rejected).toBe(2 /* resourceMetrics */ + 1 /* null metric */ + 1 /* gauge */ + 3 /* bad points */);
  });
  test('an unsupported metric is counted once per data point', () => {
    const body = metricsBody([cost({}, { name: 'other.metric' })]);
    const m = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!;
    m.sum.dataPoints.push({ ...m.sum.dataPoints[0]! }, { ...m.sum.dataPoints[0]! });
    expect(projectOtlpMetrics(body, ctxMeta)).toMatchObject({ samples: [], rejected: 3 });
  });
  test('inherited keys are not read', () => {
    const polluted = Object.create({ resourceMetrics: metricsBody([cost({})]).resourceMetrics });
    expect(projectOtlpMetrics(polluted, ctxMeta)).toEqual({ samples: [], rejected: 0, noValue: 0 });
  });
  test('getters are never invoked', () => {
    const body = metricsBody([cost({})]);
    Object.defineProperty(body.resourceMetrics[0]!, 'scopeMetrics', { get() { throw new Error('getter'); } });
    expect(() => projectOtlpMetrics(body, ctxMeta)).not.toThrow();
    expect(projectOtlpMetrics(body, ctxMeta).samples).toEqual([]);
  });
  test('array element getters are never invoked', () => {
    const body = metricsBody([cost({})]);
    Object.defineProperty(body.resourceMetrics[0]!.scopeMetrics[0]!.metrics, '0', { get() { throw new Error('getter'); } });
    expect(projectOtlpMetrics(body, ctxMeta)).toMatchObject({ samples: [], rejected: 1 });
  });
  test('duplicate attribute keys and malformed attributes reject the point', () => {
    const body = metricsBody([cost({ 'session.id': SID }), cost({}), cost({})]);
    const pts = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.map((m) => m.sum.dataPoints[0]!);
    (pts[0]!.attributes as unknown[]).push({ key: 'session.id', value: { stringValue: SID } });
    pts[1]!.attributes = 'x';
    (pts[2]!.attributes as unknown[]).push({ key: 5, value: {} });
    expect(projectOtlpMetrics(body, ctxMeta)).toMatchObject({ samples: [], rejected: 3 });
  });
  test('deeply nested attribute values are rejected, not overflowed', () => {
    let deep: unknown = { stringValue: 'x' };
    for (let i = 0; i < 10_000; i++) deep = { kvlistValue: { values: [{ key: 'k', value: deep }] } };
    const body = metricsBody([cost({})]);
    (body.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints[0]!.attributes as unknown[]).push({ key: 'deep', value: deep });
    expect(projectOtlpMetrics(body, ctxMeta)).toMatchObject({ samples: [], rejected: 1 });
  });
  test('a throwing hash is contained', () => {
    const boom: HashFn = () => { throw new Error('hash failed'); };
    expect(projectOtlpMetrics(metricsBody([cost({})]), ctxAt('metadata', boom))).toMatchObject({ samples: [], rejected: 1 });
  });
});

describe('logs', () => {
  test('phase 1 accepts no logs', () => {
    expect(projectOtlpLogs(null)).toEqual({ accepted: 0, rejected: 1 });
    expect(projectOtlpLogs({})).toEqual({ accepted: 0, rejected: 0 });
    expect(projectOtlpLogs({ resourceLogs: 'x' })).toEqual({ accepted: 0, rejected: 1 });
    expect(projectOtlpLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }, { logRecords: 'x' }] }, 3] })).toEqual({ accepted: 0, rejected: 3 });
  });
});

test('transport limit constant', () => {
  expect(MAX_OTLP_BODY_BYTES).toBe(8 * 1024 * 1024);
});

describe('review follow-up (F01, F02, F03)', () => {
  const model = (m: string, level: DetailLevel) =>
    projectOtlpMetrics(metricsBody([cost({ model: m })]), ctxAt(level)).samples[0]!.attributes.model;

  test('F01: only known families with numeric versions are readable at metadata', () => {
    for (const m of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-4', 'claude-fable-5-2', 'claude-opus-5-5-20261101']) {
      expect(model(m, 'metadata'), m).toEqual({ name: m });
    }
    const planted = 'claude-' + 'acme-secret-project';
    for (const m of [planted, 'claude-opus-five', 'claude-opus-5-5-preview', 'claude-x', 'claude-opus-5-5-2026']) {
      expect(model(m, 'metadata'), m).toEqual({ name: 'other', pseudonym: `model:${m.length}` });
    }
    expect(model(planted, 'detailed')).toEqual({ name: planted }); // readable from detailed, as documented
  });

  test('F02: the stream identity is canonical JSON (sorted keys at every depth, no whitespace)', () => {
    const sortDeep = (v: unknown): unknown => Array.isArray(v) ? v.map(sortDeep)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
        : v;
    const seen: string[] = [];
    const spy: HashFn = (k, v) => { if (k === 'stream') seen.push(v); return `${k}:x`; };
    projectOtlpMetrics(metricsBody([cost({ 'session.id': SID, b: 'B', a: 'A' }), cost({ z: '1' })], { y: '2', x: '1' }), ctxAt('metadata', spy));
    expect(seen).toHaveLength(2);
    for (const canon of seen) expect(JSON.stringify(sortDeep(JSON.parse(canon)))).toBe(canon);
  });

  test('F03: an unknown detail level or missing hash fails closed', () => {
    const body = metricsBody([cost({ model: 'acme-internal-llm' })]);
    for (const bad of [{ level: 'Metadata', hash }, { level: 'full', hash }, { level: undefined, hash }, { level: 'metadata' }, null]) {
      expect(projectOtlpMetrics(body, bad as never)).toEqual({ samples: [], rejected: 1, noValue: 0 });
    }
  });
});
